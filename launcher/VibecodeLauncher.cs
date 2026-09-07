using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

internal static class VibecodeLauncher
{
    private const string AppName = "Vibecode MCP Secure";
    private const string CredentialFileName = "launcher-runtime-key.dpapi";
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("vibecode-mcp-secure-launcher-v1");

    private sealed class Config
    {
        public string Root;
        public string Workspace;
        public string Host;
        public int Port;
        public string TunnelId;
        public string Alias;
        public string ShellMode;
        public string AllowDangerous;
        public string BrowserAllowExternal;
        public string MaxReadBytes;
        public string MaxCommandOutputBytes;

        public string McpUrl { get { return "http://" + Host + ":" + Port + "/mcp"; } }
        public string HealthUrl { get { return "http://" + Host + ":" + Port + "/healthz"; } }
        public string ReadyUrl { get { return "http://" + Host + ":" + Port + "/readyz"; } }
        public string ControlCenterUrl { get { return "http://" + Host + ":" + Port + "/"; } }
        public string RuntimeDir { get { return Path.Combine(Root, ".runtime"); } }
        public string CredentialPath { get { return Path.Combine(RuntimeDir, CredentialFileName); } }
        public string PidPath { get { return Path.Combine(RuntimeDir, "mcp.pid"); } }
        public string WatchPidPath { get { return Path.Combine(RuntimeDir, "watcher.pid"); } }
        public string WatchLogPath { get { return Path.Combine(RuntimeDir, "watcher.log"); } }
        public string TunnelExe { get { return Path.Combine(Root, "bin", "tunnel-client.exe"); } }
        public string BundledNodeExe { get { return Path.Combine(Root, "runtime", "node", "node.exe"); } }
        public string NodeExe { get { return File.Exists(BundledNodeExe) ? BundledNodeExe : FindOnPath("node.exe"); } }
        public string PlaywrightBrowsersDir { get { return Path.Combine(Root, "runtime", "playwright-browsers"); } }
    }

    private sealed class RunResult
    {
        public int ExitCode;
        public string StdOut;
        public string StdErr;
        public bool TimedOut;
    }

    public static int Main(string[] args)
    {
        Console.Title = AppName;
        Console.OutputEncoding = Encoding.UTF8;
        try
        {
            string mode = args.Length > 0 ? args[0].ToLowerInvariant() : "";
            bool noOpen = HasArg(args, "--no-open");
            Config config = LoadConfig();

            if (mode == "--self-test")
                return SelfTest(config);
            if (mode == "--reset-key")
                return ResetKey(config);
            if (mode == "--configure")
                return Configure(config);
            if (mode == "--status")
                return Status(config);
            if (mode == "--stop")
                return Stop(config);
            if (mode == "--watch")
                return Watch(config);

            return Start(config, noOpen);
        }
        catch (Exception ex)
        {
            WriteError(ex.Message);
            Console.WriteLine();
            Console.WriteLine("Press Enter to close.");
            Console.ReadLine();
            return 1;
        }
    }

    private static Config LoadConfig()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string envPath = Path.Combine(root, ".env");
        Dictionary<string, string> env = ReadEnv(envPath);
        bool placeholder = IsPlaceholder(Get(env, "VIBECODE_WORKSPACE")) || IsPlaceholder(Get(env, "CONTROL_PLANE_TUNNEL_ID"));

        Config c = new Config();
        c.Root = root;
        c.Workspace = placeholder || String.IsNullOrWhiteSpace(Get(env, "VIBECODE_WORKSPACE")) ? root : Get(env, "VIBECODE_WORKSPACE");
        c.Host = "127.0.0.1";
        c.Port = placeholder ? 1167 : ParsePort(Get(env, "VIBECODE_PORT"), 1167);
        c.TunnelId = Get(env, "CONTROL_PLANE_TUNNEL_ID");
        c.Alias = NonEmpty(Get(env, "TUNNEL_ALIAS"), "vibecode-local");
        c.ShellMode = NonEmpty(Get(env, "VIBECODE_SHELL_MODE"), "allowlist");
        c.AllowDangerous = NonEmpty(Get(env, "VIBECODE_ALLOW_DANGEROUS"), "0");
        c.BrowserAllowExternal = NonEmpty(Get(env, "VIBECODE_BROWSER_ALLOW_EXTERNAL"), "0");
        c.MaxReadBytes = NonEmpty(Get(env, "VIBECODE_MAX_READ_BYTES"), "262144");
        c.MaxCommandOutputBytes = NonEmpty(Get(env, "VIBECODE_MAX_COMMAND_OUTPUT_BYTES"), "262144");

        if (!Directory.Exists(c.Workspace))
            c.Workspace = root;

        Directory.CreateDirectory(c.RuntimeDir);

        if ((String.IsNullOrWhiteSpace(c.TunnelId) || IsPlaceholder(c.TunnelId)) && File.Exists(c.TunnelExe))
        {
            string discovered = TryDiscoverTunnelId(c);
            if (!String.IsNullOrWhiteSpace(discovered))
                c.TunnelId = discovered;
        }

        if (placeholder || !File.Exists(envPath) || Get(env, "VIBECODE_PORT") != c.Port.ToString() || Get(env, "VIBECODE_WORKSPACE") != c.Workspace || Get(env, "CONTROL_PLANE_TUNNEL_ID") != c.TunnelId)
            WriteEnv(c);

        return c;
    }

    private static int Start(Config c, bool noOpen)
    {
        PrintHeader();
        ValidateRuntime(c);

        bool healthOk = HttpOk(c.HealthUrl, 1200);
        if (healthOk && !IsExpectedVibecodeMcp(c))
            throw new Exception("Port " + c.Port + " is already serving a different Vibecode MCP checkout. This launcher will not attach to or replace it. Stop that checkout or configure a different local port.");

        if (!healthOk)
        {
            int listenerPid = FindListeningPid(c);
            if (listenerPid > 0)
                throw new Exception("Port " + c.Port + " is already occupied by PID " + listenerPid + ". This launcher will not replace an unverified listener. Stop it or configure a different local port.");
            WriteInfo("Starting local MCP server on " + c.Host + ":" + c.Port + " ...");
            StartMcp(c);
            if (!WaitHttp(c.HealthUrl, 40, 500))
                throw new Exception("MCP health check failed. Run DOCTOR.cmd or inspect the server console.");
            if (!IsExpectedVibecodeMcp(c))
                throw new Exception("A process started on port " + c.Port + " but did not identify as this Vibecode MCP checkout.");
        }
        else
        {
            WriteOk("MCP is already healthy.");
        }

        if (!WaitHttp(c.ReadyUrl, 8, 500))
            throw new Exception("MCP is alive but /readyz is not ready.");

        WriteOk("MCP ready: " + c.McpUrl);

        if (!TunnelReady(c))
        {
            WriteInfo("Secure Tunnel is not ready for this MCP URL. Reconnecting...");
            bool connected = TryProfileConnect(c);
            if (!connected)
            {
                EnsureTunnelId(c);
                string runtimeKey = GetRuntimeKey(c, true);
                connected = ConnectWithRuntimeKey(c, runtimeKey);
                runtimeKey = null;
            }

            if (!connected || !WaitTunnelReady(c, 30, 500))
                throw new Exception("Tunnel connection did not become ready.");
        }

        WriteOk("Tunnel ready: alias '" + c.Alias + "'.");
        EnsureWatcher(c);
        Console.WriteLine();
        Console.WriteLine("MCP:     " + c.McpUrl);
        Console.WriteLine("Control: " + c.ControlCenterUrl);
        Console.WriteLine("Projects: Multi-Project Router enabled");
        Console.WriteLine();

        if (!noOpen)
            OpenUrl(c.ControlCenterUrl);

        WriteOk("VIBECODE MCP IS RUNNING");
        Thread.Sleep(1200);
        return 0;
    }

    private static int Configure(Config c)
    {
        PrintHeader();
        Console.WriteLine("One-time launcher configuration.");
        Console.WriteLine();

        Console.Write("Workspace [" + c.Root + "]: ");
        string workspace = Console.ReadLine();
        if (!String.IsNullOrWhiteSpace(workspace))
            c.Workspace = workspace.Trim();
        else
            c.Workspace = c.Root;
        if (!Directory.Exists(c.Workspace))
            throw new Exception("Workspace does not exist: " + c.Workspace);

        Console.Write("Port [" + c.Port + "]: ");
        string portText = Console.ReadLine();
        if (!String.IsNullOrWhiteSpace(portText))
            c.Port = ParsePort(portText.Trim(), c.Port);

        Console.Write("Tunnel alias [" + c.Alias + "]: ");
        string alias = Console.ReadLine();
        if (!String.IsNullOrWhiteSpace(alias))
            c.Alias = alias.Trim();

        string discovered = TryDiscoverTunnelId(c);
        if (!String.IsNullOrWhiteSpace(discovered))
            c.TunnelId = discovered;

        Console.Write("Tunnel ID [" + MaskId(c.TunnelId) + "]: ");
        string tunnelId = Console.ReadLine();
        if (!String.IsNullOrWhiteSpace(tunnelId))
            c.TunnelId = tunnelId.Trim();
        EnsureTunnelId(c);

        string key = ReadSecret("OpenAI Runtime API key (saved with Windows DPAPI): ");
        if (String.IsNullOrWhiteSpace(key))
            throw new Exception("Runtime API key cannot be empty.");
        SaveRuntimeKey(c, key);
        key = null;

        WriteEnv(c);
        WriteOk("Configuration saved. Runtime API key is encrypted with Windows DPAPI and is not stored in .env.");
        return 0;
    }

    private static int Status(Config c)
    {
        PrintHeader();
        Console.WriteLine("Root:      " + c.Root);
        Console.WriteLine("Workspace: " + c.Workspace);
        Console.WriteLine("MCP URL:   " + c.McpUrl);
        bool healthOk = HttpOk(c.HealthUrl, 1200);
        bool expectedMcp = healthOk && IsExpectedVibecodeMcp(c);
        Console.WriteLine("MCP:       " + (expectedMcp ? "healthy" : healthOk ? "different Vibecode checkout on this port" : "offline"));
        Console.WriteLine("Ready:     " + (expectedMcp && HttpOk(c.ReadyUrl, 1200) ? "yes" : "no"));
        Console.WriteLine("Tunnel:    " + (expectedMcp && TunnelReady(c) ? "ready" : "not checked"));
        Console.WriteLine("Alias:     " + c.Alias);
        Console.WriteLine("Tunnel ID: " + (ValidTunnelId(c.TunnelId) ? "configured" : "missing"));
        Console.WriteLine("DPAPI key: " + (File.Exists(c.CredentialPath) ? "stored" : "not stored"));
        return 0;
    }

    private static int Stop(Config c)
    {
        PrintHeader();
        if (HttpOk(c.HealthUrl, 1200) && !IsExpectedVibecodeMcp(c))
        {
            WriteWarn("Port " + c.Port + " belongs to a different Vibecode MCP checkout. Refusing to stop its MCP or tunnel.");
            return 2;
        }
        if (File.Exists(c.TunnelExe))
        {
            WriteInfo("Stopping tunnel alias '" + c.Alias + "'...");
            Run(c.TunnelExe, "runtimes stop " + Q(c.Alias), c.Root, null, 20000);
        }

        int listenerPid = IsExpectedVibecodeMcp(c) ? FindListeningPid(c) : 0;
        if (listenerPid > 0)
        {
            try
            {
                WriteInfo("Stopping MCP listener PID " + listenerPid + "...");
                Run("taskkill.exe", "/PID " + listenerPid + " /T /F", c.Root, null, 15000);
            }
            catch { }
        }
        else
        {
            WriteInfo("No verified Vibecode MCP listener found on port " + c.Port + ".");
        }

        StopWatcher(c);
        try { if (File.Exists(c.PidPath)) File.Delete(c.PidPath); } catch { }
        WriteOk("Stopped launcher-managed MCP/tunnel.");
        return 0;
    }

    private static int FindListeningPid(Config c)
    {
        try
        {
            RunResult net = Run("netstat.exe", "-ano -p tcp", c.Root, null, 10000);
            if (net.ExitCode != 0) return 0;
            string expected = c.Host + ":" + c.Port;
            foreach (string raw in (net.StdOut ?? "").Split(new[] { "\r\n", "\n" }, StringSplitOptions.RemoveEmptyEntries))
            {
                string line = raw.Trim();
                if (!line.StartsWith("TCP", StringComparison.OrdinalIgnoreCase) || line.IndexOf("LISTENING", StringComparison.OrdinalIgnoreCase) < 0) continue;
                string[] parts = Regex.Split(line, @"\s+");
                if (parts.Length < 5 || !String.Equals(parts[1], expected, StringComparison.OrdinalIgnoreCase)) continue;
                int pid;
                if (Int32.TryParse(parts[parts.Length - 1], out pid)) return pid;
            }
        }
        catch { }
        return 0;
    }

    private static bool IsExpectedVibecodeMcp(Config c)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(c.HealthUrl);
            req.Method = "GET";
            req.Timeout = 1500;
            req.ReadWriteTimeout = 1500;
            req.Proxy = null;
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            using (StreamReader reader = new StreamReader(res.GetResponseStream()))
            {
                string body = reader.ReadToEnd();
                string expectedRoot = Path.GetFullPath(c.Root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                string expectedRootJson = expectedRoot.Replace("\\", "\\\\").Replace("\"", "\\\"");
                return body.IndexOf("\"service\":\"vibecode-mcp-secure\"", StringComparison.OrdinalIgnoreCase) >= 0
                    && body.IndexOf("\"serverRoot\":\"" + expectedRootJson + "\"", StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }
        catch { return false; }
    }

    private static int ResetKey(Config c)
    {
        if (File.Exists(c.CredentialPath))
            File.Delete(c.CredentialPath);
        WriteOk("Saved DPAPI Runtime API key removed.");
        return 0;
    }

    private static int SelfTest(Config c)
    {
        PrintHeader();
        bool ok = true;
        ok &= Check("Project root", Directory.Exists(c.Root));
        ok &= Check("src/server.mjs", File.Exists(Path.Combine(c.Root, "src", "server.mjs")));
        ok &= Check("Node.js", !String.IsNullOrWhiteSpace(c.NodeExe));
        ok &= Check("tunnel-client.exe", File.Exists(c.TunnelExe));
        ok &= Check("Port", c.Port > 0 && c.Port < 65536);

        try
        {
            byte[] sample = Encoding.UTF8.GetBytes("vibecode-dpapi-self-test");
            byte[] encrypted = ProtectedData.Protect(sample, Entropy, DataProtectionScope.CurrentUser);
            byte[] decrypted = ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.CurrentUser);
            ok &= Check("Windows DPAPI", Encoding.UTF8.GetString(decrypted) == "vibecode-dpapi-self-test");
        }
        catch
        {
            ok &= Check("Windows DPAPI", false);
        }

        Console.WriteLine();
        if (ok) WriteOk("Launcher self-test PASS");
        else WriteError("Launcher self-test FAILED");
        return ok ? 0 : 2;
    }

    private static void ValidateRuntime(Config c)
    {
        if (!File.Exists(Path.Combine(c.Root, "src", "server.mjs")))
            throw new Exception("src/server.mjs not found next to launcher.");
        if (String.IsNullOrWhiteSpace(c.NodeExe))
            throw new Exception("Node.js 20+ was not found. The portable package needs runtime\\node\\node.exe; development installs may use Node.js on PATH.");
        if (!File.Exists(c.TunnelExe))
            throw new Exception("bin\\tunnel-client.exe not found. Run SETUP.cmd first.");
        if (!Directory.Exists(c.Workspace))
            throw new Exception("Workspace not found: " + c.Workspace);
    }

    private static void StartMcp(Config c)
    {
        string node = c.NodeExe;
        if (String.IsNullOrWhiteSpace(node)) throw new Exception("Node.js was not found.");

        Environment.SetEnvironmentVariable("VIBECODE_WORKSPACE", c.Workspace);
        Environment.SetEnvironmentVariable("VIBECODE_HOST", c.Host);
        Environment.SetEnvironmentVariable("VIBECODE_PORT", c.Port.ToString());
        Environment.SetEnvironmentVariable("VIBECODE_RUNTIME_DIR", c.RuntimeDir);
        Environment.SetEnvironmentVariable("CONTROL_PLANE_TUNNEL_ID", c.TunnelId ?? "");
        Environment.SetEnvironmentVariable("TUNNEL_ALIAS", c.Alias);
        Environment.SetEnvironmentVariable("VIBECODE_SHELL_MODE", c.ShellMode);
        Environment.SetEnvironmentVariable("VIBECODE_ALLOW_DANGEROUS", c.AllowDangerous);
        Environment.SetEnvironmentVariable("VIBECODE_BROWSER_ALLOW_EXTERNAL", c.BrowserAllowExternal);
        Environment.SetEnvironmentVariable("VIBECODE_MAX_READ_BYTES", c.MaxReadBytes);
        Environment.SetEnvironmentVariable("VIBECODE_MAX_COMMAND_OUTPUT_BYTES", c.MaxCommandOutputBytes);
        if (Directory.Exists(c.PlaywrightBrowsersDir))
            Environment.SetEnvironmentVariable("PLAYWRIGHT_BROWSERS_PATH", c.PlaywrightBrowsersDir);

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = node;
        psi.Arguments = "src/server.mjs";
        psi.WorkingDirectory = c.Root;
        psi.UseShellExecute = true;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;

        Process p = Process.Start(psi);
        if (p == null) throw new Exception("Could not start node process.");
        File.WriteAllText(c.PidPath, p.Id.ToString(), Encoding.ASCII);
    }

    private static int Watch(Config c)
    {
        File.WriteAllText(c.WatchPidPath, Process.GetCurrentProcess().Id.ToString(), Encoding.ASCII);
        WriteWatch(c, "watcher started");
        try
        {
            while (true)
            {
                if (!HttpOk(c.HealthUrl, 1500))
                {
                    int listenerPid = FindListeningPid(c);
                    if (listenerPid > 0) WriteWatch(c, "health failed but port is occupied by PID " + listenerPid + "; not replacing it");
                    else
                    {
                        try
                        {
                            if (File.Exists(c.PidPath)) File.Delete(c.PidPath);
                            StartMcp(c);
                            WriteWatch(c, WaitHttp(c.HealthUrl, 20, 500) ? "MCP restarted" : "MCP restart did not become healthy");
                        }
                        catch (Exception ex) { WriteWatch(c, "MCP restart failed: " + ex.Message); }
                    }
                }
                Thread.Sleep(10000);
            }
        }
        finally { try { if (File.Exists(c.WatchPidPath)) File.Delete(c.WatchPidPath); } catch { } }
    }

    private static void EnsureWatcher(Config c)
    {
        int existing;
        if (File.Exists(c.WatchPidPath) && Int32.TryParse(File.ReadAllText(c.WatchPidPath).Trim(), out existing))
        {
            try { Process.GetProcessById(existing); return; } catch { try { File.Delete(c.WatchPidPath); } catch { } }
        }
        var psi = new ProcessStartInfo { FileName = Process.GetCurrentProcess().MainModule.FileName, Arguments = "--watch", WorkingDirectory = c.Root, UseShellExecute = false, CreateNoWindow = true };
        Process.Start(psi);
    }

    private static void StopWatcher(Config c)
    {
        try
        {
            int pid;
            if (File.Exists(c.WatchPidPath) && Int32.TryParse(File.ReadAllText(c.WatchPidPath).Trim(), out pid)) Run("taskkill.exe", "/PID " + pid + " /T /F", c.Root, null, 15000);
        }
        catch { }
        try { if (File.Exists(c.WatchPidPath)) File.Delete(c.WatchPidPath); } catch { }
    }

    private static void WriteWatch(Config c, string message)
    {
        try { File.AppendAllText(c.WatchLogPath, DateTime.Now.ToString("o") + " " + message + Environment.NewLine, Encoding.UTF8); } catch { }
    }

    private static void SetChildEnv(ProcessStartInfo psi, Config c)
    {
        psi.EnvironmentVariables["VIBECODE_WORKSPACE"] = c.Workspace;
        psi.EnvironmentVariables["VIBECODE_HOST"] = c.Host;
        psi.EnvironmentVariables["VIBECODE_PORT"] = c.Port.ToString();
        psi.EnvironmentVariables["VIBECODE_RUNTIME_DIR"] = c.RuntimeDir;
        psi.EnvironmentVariables["CONTROL_PLANE_TUNNEL_ID"] = c.TunnelId ?? "";
        psi.EnvironmentVariables["TUNNEL_ALIAS"] = c.Alias;
        psi.EnvironmentVariables["VIBECODE_SHELL_MODE"] = c.ShellMode;
        psi.EnvironmentVariables["VIBECODE_ALLOW_DANGEROUS"] = c.AllowDangerous;
        psi.EnvironmentVariables["VIBECODE_BROWSER_ALLOW_EXTERNAL"] = c.BrowserAllowExternal;
        psi.EnvironmentVariables["VIBECODE_MAX_READ_BYTES"] = c.MaxReadBytes;
        psi.EnvironmentVariables["VIBECODE_MAX_COMMAND_OUTPUT_BYTES"] = c.MaxCommandOutputBytes;
    }

    private static bool TunnelReady(Config c)
    {
        if (!File.Exists(c.TunnelExe)) return false;
        RunResult status = Run(c.TunnelExe, "runtimes status " + Q(c.Alias) + " --json", c.Root, null, 15000);
        if (status.ExitCode != 0) return false;
        string all = (status.StdOut ?? "") + "\n" + (status.StdErr ?? "");
        return Regex.IsMatch(all, "\"ready\"\\s*:\\s*true", RegexOptions.IgnoreCase)
            && all.IndexOf(c.McpUrl, StringComparison.OrdinalIgnoreCase) >= 0;
    }

    private static bool WaitTunnelReady(Config c, int attempts, int delayMs)
    {
        for (int i = 0; i < attempts; i++)
        {
            if (TunnelReady(c)) return true;
            Thread.Sleep(delayMs);
        }
        return false;
    }

    private static bool TryProfileConnect(Config c)
    {
        RunResult result = Run(c.TunnelExe,
            "runtimes connect --alias " + Q(c.Alias) + " --mcp-server-url " + Q(c.McpUrl),
            c.Root, null, 30000);
        if (result.ExitCode != 0)
            return false;
        return WaitTunnelReady(c, 20, 500);
    }

    private static bool ConnectWithRuntimeKey(Config c, string runtimeKey)
    {
        Dictionary<string, string> extra = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        extra["CONTROL_PLANE_API_KEY"] = runtimeKey;

        string args = "runtimes connect --alias " + Q(c.Alias)
            + " --tunnel-id " + Q(c.TunnelId)
            + " --runtime-api-key env:CONTROL_PLANE_API_KEY"
            + " --mcp-server-url " + Q(c.McpUrl);

        RunResult result = Run(c.TunnelExe, args, c.Root, extra, 45000);
        return result.ExitCode == 0;
    }

    private static string TryDiscoverTunnelId(Config c)
    {
        if (!File.Exists(c.TunnelExe)) return null;
        RunResult result = Run(c.TunnelExe, "runtimes status " + Q(c.Alias) + " --json", c.Root, null, 15000);
        if (result.ExitCode != 0) return null;
        string all = (result.StdOut ?? "") + "\n" + (result.StdErr ?? "");
        Match m = Regex.Match(all, "\"tunnel_id\"\\s*:\\s*\"(?<id>tunnel_[A-Za-z0-9_-]+)\"", RegexOptions.IgnoreCase);
        return m.Success ? m.Groups["id"].Value : null;
    }

    private static void EnsureTunnelId(Config c)
    {
        if (ValidTunnelId(c.TunnelId)) return;
        string discovered = TryDiscoverTunnelId(c);
        if (ValidTunnelId(discovered))
        {
            c.TunnelId = discovered;
            WriteEnv(c);
            return;
        }

        Console.Write("OpenAI Secure MCP Tunnel ID (tunnel_...): ");
        string value = Console.ReadLine();
        if (!ValidTunnelId(value))
            throw new Exception("A valid tunnel_... ID is required.");
        c.TunnelId = value.Trim();
        WriteEnv(c);
    }

    private static string GetRuntimeKey(Config c, bool promptIfMissing)
    {
        string envKey = Environment.GetEnvironmentVariable("CONTROL_PLANE_API_KEY");
        if (!String.IsNullOrWhiteSpace(envKey))
            return envKey;

        if (File.Exists(c.CredentialPath))
        {
            try
            {
                byte[] encrypted = File.ReadAllBytes(c.CredentialPath);
                byte[] clear = ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.CurrentUser);
                string value = Encoding.UTF8.GetString(clear);
                Array.Clear(clear, 0, clear.Length);
                if (!String.IsNullOrWhiteSpace(value))
                    return value;
            }
            catch
            {
                WriteWarn("Saved DPAPI key could not be decrypted. It may belong to another Windows user.");
            }
        }

        if (!promptIfMissing)
            return null;

        string key = ReadSecret("OpenAI Runtime API key (first time only; saved encrypted with Windows DPAPI): ");
        if (String.IsNullOrWhiteSpace(key))
            throw new Exception("Runtime API key is required to connect the tunnel.");
        SaveRuntimeKey(c, key);
        return key;
    }

    private static void SaveRuntimeKey(Config c, string key)
    {
        Directory.CreateDirectory(c.RuntimeDir);
        byte[] clear = Encoding.UTF8.GetBytes(key);
        byte[] encrypted = ProtectedData.Protect(clear, Entropy, DataProtectionScope.CurrentUser);
        Array.Clear(clear, 0, clear.Length);
        File.WriteAllBytes(c.CredentialPath, encrypted);
        try { File.SetAttributes(c.CredentialPath, File.GetAttributes(c.CredentialPath) | FileAttributes.Hidden); } catch { }
    }

    private static Dictionary<string, string> ReadEnv(string path)
    {
        Dictionary<string, string> values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!File.Exists(path)) return values;
        string[] lines = File.ReadAllLines(path);
        foreach (string raw in lines)
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith("#")) continue;
            int idx = line.IndexOf('=');
            if (idx < 1) continue;
            string key = line.Substring(0, idx).Trim();
            string value = line.Substring(idx + 1).Trim();
            if ((value.StartsWith("\"") && value.EndsWith("\"")) || (value.StartsWith("'") && value.EndsWith("'")))
                value = value.Substring(1, value.Length - 2);
            values[key] = value;
        }
        return values;
    }

    private static void WriteEnv(Config c)
    {
        string envPath = Path.Combine(c.Root, ".env");
        StringBuilder sb = new StringBuilder();
        sb.AppendLine("# Non-secret launcher/runtime configuration.");
        sb.AppendLine("# Runtime API key is stored separately with Windows DPAPI in .runtime.");
        sb.AppendLine("VIBECODE_WORKSPACE=" + EnvValue(c.Workspace));
        sb.AppendLine("VIBECODE_HOST=127.0.0.1");
        sb.AppendLine("VIBECODE_PORT=" + c.Port);
        sb.AppendLine("CONTROL_PLANE_TUNNEL_ID=" + EnvValue(c.TunnelId ?? "tunnel_REPLACE_ME"));
        sb.AppendLine("TUNNEL_ALIAS=" + EnvValue(c.Alias));
        sb.AppendLine("VIBECODE_SHELL_MODE=" + c.ShellMode);
        sb.AppendLine("VIBECODE_ALLOW_DANGEROUS=" + c.AllowDangerous);
        sb.AppendLine("VIBECODE_BROWSER_ALLOW_EXTERNAL=" + c.BrowserAllowExternal);
        sb.AppendLine("VIBECODE_MAX_READ_BYTES=" + c.MaxReadBytes);
        sb.AppendLine("VIBECODE_MAX_COMMAND_OUTPUT_BYTES=" + c.MaxCommandOutputBytes);
        File.WriteAllText(envPath, sb.ToString(), new UTF8Encoding(false));
    }

    private static RunResult Run(string file, string args, string cwd, Dictionary<string, string> extraEnv, int timeoutMs)
    {
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = file;
        psi.Arguments = args;
        psi.WorkingDirectory = cwd;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        if (extraEnv != null)
        {
            foreach (KeyValuePair<string, string> kv in extraEnv)
                psi.EnvironmentVariables[kv.Key] = kv.Value;
        }

        RunResult result = new RunResult();
        using (Process p = Process.Start(psi))
        {
            if (p == null)
            {
                result.ExitCode = -1;
                result.StdErr = "Process did not start.";
                return result;
            }

            string stdout = p.StandardOutput.ReadToEnd();
            string stderr = p.StandardError.ReadToEnd();
            bool exited = p.WaitForExit(timeoutMs);
            if (!exited)
            {
                result.TimedOut = true;
                try { p.Kill(); } catch { }
                result.ExitCode = -2;
            }
            else
            {
                result.ExitCode = p.ExitCode;
            }
            result.StdOut = stdout;
            result.StdErr = stderr;
        }
        return result;
    }

    private static bool WaitHttp(string url, int attempts, int delayMs)
    {
        for (int i = 0; i < attempts; i++)
        {
            if (HttpOk(url, 1500)) return true;
            Thread.Sleep(delayMs);
        }
        return false;
    }

    private static bool HttpOk(string url, int timeoutMs)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "GET";
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.Proxy = null;
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            {
                int code = (int)res.StatusCode;
                return code >= 200 && code < 300;
            }
        }
        catch { return false; }
    }

    private static string FindOnPath(string executable)
    {
        string pathValue = Environment.GetEnvironmentVariable("PATH") ?? "";
        string[] dirs = pathValue.Split(Path.PathSeparator);
        foreach (string dir in dirs)
        {
            try
            {
                string candidate = Path.Combine(dir.Trim(), executable);
                if (File.Exists(candidate)) return candidate;
            }
            catch { }
        }
        return null;
    }

    private static string ReadSecret(string prompt)
    {
        Console.Write(prompt);
        if (Console.IsInputRedirected)
            return Console.ReadLine();

        StringBuilder sb = new StringBuilder();
        while (true)
        {
            ConsoleKeyInfo key = Console.ReadKey(true);
            if (key.Key == ConsoleKey.Enter)
            {
                Console.WriteLine();
                break;
            }
            if (key.Key == ConsoleKey.Backspace)
            {
                if (sb.Length > 0)
                {
                    sb.Length--;
                    Console.Write("\b \b");
                }
                continue;
            }
            if (!Char.IsControl(key.KeyChar))
            {
                sb.Append(key.KeyChar);
                Console.Write("*");
            }
        }
        return sb.ToString();
    }

    private static void OpenUrl(string url)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(url);
            psi.UseShellExecute = true;
            Process.Start(psi);
        }
        catch { }
    }

    private static bool ValidTunnelId(string value)
    {
        return !String.IsNullOrWhiteSpace(value)
            && Regex.IsMatch(value.Trim(), "^tunnel_[A-Za-z0-9_-]+$")
            && value.IndexOf("REPLACE_ME", StringComparison.OrdinalIgnoreCase) < 0;
    }

    private static bool IsPlaceholder(string value)
    {
        if (String.IsNullOrWhiteSpace(value)) return true;
        return value.IndexOf("your-project", StringComparison.OrdinalIgnoreCase) >= 0
            || value.IndexOf("REPLACE_ME", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    private static int ParsePort(string value, int fallback)
    {
        int port;
        if (Int32.TryParse(value, out port) && port > 0 && port < 65536)
            return port;
        return fallback;
    }

    private static string Get(Dictionary<string, string> env, string key)
    {
        string value;
        return env.TryGetValue(key, out value) ? value : null;
    }

    private static string NonEmpty(string value, string fallback)
    {
        return String.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
    }

    private static string EnvValue(string value)
    {
        if (value == null) return "";
        if (value.IndexOf(' ') >= 0 || value.IndexOf('#') >= 0)
            return "\"" + value.Replace("\"", "") + "\"";
        return value;
    }

    private static string Q(string value)
    {
        return "\"" + (value ?? "").Replace("\"", "\\\"") + "\"";
    }

    private static string MaskId(string value)
    {
        if (!ValidTunnelId(value)) return "not configured";
        if (value.Length <= 14) return "configured";
        return value.Substring(0, 7) + "..." + value.Substring(value.Length - 5);
    }

    private static bool HasArg(string[] args, string target)
    {
        foreach (string arg in args)
            if (String.Equals(arg, target, StringComparison.OrdinalIgnoreCase))
                return true;
        return false;
    }

    private static bool Check(string label, bool ok)
    {
        Console.WriteLine((ok ? "[ OK ] " : "[FAIL] ") + label);
        return ok;
    }

    private static void PrintHeader()
    {
        Console.WriteLine("==============================================");
        Console.WriteLine("  VIBECODE MCP SECURE - WINDOWS LAUNCHER");
        Console.WriteLine("==============================================");
        Console.WriteLine();
    }

    private static void WriteOk(string text)
    {
        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine("[OK] " + text);
        Console.ResetColor();
    }

    private static void WriteInfo(string text)
    {
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("[..] " + text);
        Console.ResetColor();
    }

    private static void WriteWarn(string text)
    {
        Console.ForegroundColor = ConsoleColor.Yellow;
        Console.WriteLine("[!!] " + text);
        Console.ResetColor();
    }

    private static void WriteError(string text)
    {
        Console.ForegroundColor = ConsoleColor.Red;
        Console.WriteLine("[ERROR] " + text);
        Console.ResetColor();
    }
}
