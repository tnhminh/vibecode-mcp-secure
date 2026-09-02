using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Web.Script.Serialization;

internal static class VibecodeDesktopApp
{
    [STAThread]
    public static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        string cli = Path.Combine(root, "VibecodeMCP.Cli.exe");

        if (args != null && args.Length > 0)
        {
            if (String.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    if (!File.Exists(cli)) return 2;
                    if (!File.Exists(Path.Combine(root, "src", "server.mjs"))) return 3;
                    using (var form = new MainForm(true)) { }
                    return 0;
                }
                catch { return 9; }
            }

            if (!File.Exists(cli)) return 10;
            var psi = new ProcessStartInfo
            {
                FileName = cli,
                Arguments = String.Join(" ", args),
                WorkingDirectory = root,
                UseShellExecute = true
            };
            using (var p = Process.Start(psi))
            {
                if (p == null) return 11;
                p.WaitForExit();
                return p.ExitCode;
            }
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainForm(false));
        return 0;
    }
}

internal sealed class TimeoutWebClient : WebClient
{
    public int TimeoutMs = 1600;
    protected override WebRequest GetWebRequest(Uri address)
    {
        WebRequest req = base.GetWebRequest(address);
        req.Timeout = TimeoutMs;
        var http = req as HttpWebRequest;
        if (http != null) http.ReadWriteTimeout = TimeoutMs;
        return req;
    }
}

internal sealed class MainForm : Form
{
    private readonly string root;
    private readonly string cliPath;
    private readonly string runtimeDir;
    private readonly string envPath;
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    private readonly NotifyIcon tray = new NotifyIcon();

    private TabControl tabs;
    private Label statusPill;
    private Label mcpValue;
    private Label tunnelValue;
    private Label endpointValue;
    private Label projectValue;
    private Label gitValue;
    private Label securityValue;
    private Label processValue;
    private Label footer;
    private Label refreshed;
    private DataGridView projectsGrid;
    private TextBox logs;
    private TextBox workspaceBox;
    private NumericUpDown portBox;
    private TextBox aliasBox;
    private TextBox tunnelBox;
    private TextBox keyBox;
    private Button startButton;
    private Button stopButton;
    private Button restartButton;
    private Button refreshButton;

    private string baseUrl = "http://127.0.0.1:1167";
    private volatile bool busy;

    public MainForm(bool testMode)
    {
        root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        cliPath = Path.Combine(root, "VibecodeMCP.Cli.exe");
        runtimeDir = Path.Combine(root, ".runtime");
        envPath = Path.Combine(root, ".env");

        BuildUi();
        LoadSettings();

        if (testMode) return;

        tray.Icon = SystemIcons.Application;
        tray.Text = "Vibecode MCP Secure";
        tray.Visible = true;
        tray.DoubleClick += delegate { RestoreFromTray(); };
        var menu = new ContextMenuStrip();
        menu.Items.Add("Show", null, delegate { RestoreFromTray(); });
        menu.Items.Add("Start All", null, delegate { RunCli("--no-open", "Starting MCP + Tunnel..."); });
        menu.Items.Add("Stop", null, delegate { RunCli("--stop", "Stopping MCP + Tunnel..."); });
        menu.Items.Add("Exit", null, delegate { tray.Visible = false; Application.Exit(); });
        tray.ContextMenuStrip = menu;

        Resize += delegate
        {
            if (WindowState == FormWindowState.Minimized)
            {
                Hide();
                tray.ShowBalloonTip(1200, "Vibecode MCP", "Control Center is still running in the system tray.", ToolTipIcon.Info);
            }
        };

        FormClosing += delegate(object sender, FormClosingEventArgs e)
        {
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                WindowState = FormWindowState.Minimized;
                Hide();
            }
        };

        timer.Interval = 4000;
        timer.Tick += delegate { RefreshAll(false); };
        timer.Start();

        Shown += delegate
        {
            RefreshAll(true);
            RunCli("--no-open", "Ensuring MCP + Secure Tunnel are running...");
        };
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            timer.Dispose();
            tray.Visible = false;
            tray.Dispose();
        }
        base.Dispose(disposing);
    }

    private void BuildUi()
    {
        Text = "Vibecode MCP Secure";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(980, 680);
        Size = new Size(1180, 790);
        BackColor = Color.FromArgb(245, 247, 251);
        Font = new Font("Segoe UI", 9F);

        var shell = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 3, ColumnCount = 1 };
        shell.RowStyles.Add(new RowStyle(SizeType.Absolute, 82));
        shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        shell.RowStyles.Add(new RowStyle(SizeType.Absolute, 34));
        Controls.Add(shell);

        var header = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(15, 23, 42) };
        shell.Controls.Add(header, 0, 0);
        header.Controls.Add(new Label
        {
            Text = "Vibecode MCP Secure",
            ForeColor = Color.White,
            Font = new Font("Segoe UI Semibold", 18F, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(22, 12)
        });
        header.Controls.Add(new Label
        {
            Text = "Windows App · MCP + Secure Tunnel + Multi-Project Router",
            ForeColor = Color.FromArgb(148, 163, 184),
            AutoSize = true,
            Location = new Point(24, 49)
        });
        statusPill = new Label
        {
            Text = "● Checking",
            ForeColor = Color.FromArgb(251, 191, 36),
            BackColor = Color.FromArgb(30, 41, 59),
            TextAlign = ContentAlignment.MiddleCenter,
            Size = new Size(140, 34),
            Anchor = AnchorStyles.Top | AnchorStyles.Right,
            Location = new Point(1000, 23)
        };
        header.Controls.Add(statusPill);
        header.Resize += delegate { statusPill.Left = header.ClientSize.Width - statusPill.Width - 22; };

        tabs = new TabControl { Dock = DockStyle.Fill, Padding = new Point(18, 8) };
        tabs.TabPages.Add(BuildOverview());
        tabs.TabPages.Add(BuildProjects());
        tabs.TabPages.Add(BuildLogs());
        tabs.TabPages.Add(BuildSettings());
        shell.Controls.Add(tabs, 0, 1);

        var bottom = new Panel { Dock = DockStyle.Fill, BackColor = Color.White };
        footer = new Label { Text = "Ready", AutoSize = true, ForeColor = Color.FromArgb(100, 116, 139), Location = new Point(14, 8) };
        refreshed = new Label { Text = "Not refreshed", AutoSize = true, ForeColor = Color.FromArgb(148, 163, 184), Anchor = AnchorStyles.Top | AnchorStyles.Right, Location = new Point(1000, 8) };
        bottom.Controls.Add(footer);
        bottom.Controls.Add(refreshed);
        bottom.Resize += delegate { refreshed.Left = bottom.ClientSize.Width - refreshed.Width - 14; };
        shell.Controls.Add(bottom, 0, 2);
    }

    private TabPage BuildOverview()
    {
        var page = NewPage("Overview");
        var actions = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 56, Padding = new Padding(6, 9, 0, 6) };
        startButton = ButtonOf("Start All", Color.FromArgb(37, 99, 235), Color.White);
        restartButton = ButtonOf("Restart", Color.White, Color.FromArgb(30, 64, 175));
        stopButton = ButtonOf("Stop", Color.White, Color.FromArgb(185, 28, 28));
        refreshButton = ButtonOf("Refresh", Color.White, Color.FromArgb(51, 65, 85));
        var web = ButtonOf("Open Web Console", Color.White, Color.FromArgb(51, 65, 85));

        startButton.Click += delegate { RunCli("--no-open", "Starting MCP + Tunnel..."); };
        restartButton.Click += delegate { RestartAll(); };
        stopButton.Click += delegate { RunCli("--stop", "Stopping MCP + Tunnel..."); };
        refreshButton.Click += delegate { RefreshAll(true); };
        web.Click += delegate { OpenUrl(baseUrl + "/"); };

        actions.Controls.Add(startButton);
        actions.Controls.Add(restartButton);
        actions.Controls.Add(stopButton);
        actions.Controls.Add(refreshButton);
        actions.Controls.Add(web);
        page.Controls.Add(actions);

        var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 4, Padding = new Padding(6, 4, 6, 6) };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        for (int i = 0; i < 4; i++) grid.RowStyles.Add(new RowStyle(SizeType.Percent, 25));

        mcpValue = AddCard(grid, 0, 0, "MCP SERVER");
        tunnelValue = AddCard(grid, 1, 0, "SECURE TUNNEL");
        endpointValue = AddCard(grid, 0, 1, "MCP ENDPOINT");
        projectValue = AddCard(grid, 1, 1, "DEFAULT PROJECT");
        gitValue = AddCard(grid, 0, 2, "GIT");
        securityValue = AddCard(grid, 1, 2, "SECURITY");
        processValue = AddCard(grid, 0, 3, "PROCESSES");
        AddDesktopCard(grid, 1, 3);

        page.Controls.Add(grid);
        grid.BringToFront();
        return page;
    }

    private TabPage BuildProjects()
    {
        var page = NewPage("Projects");
        var actions = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 56, Padding = new Padding(6, 9, 0, 6) };
        var add = ButtonOf("+ Add Project", Color.FromArgb(37, 99, 235), Color.White);
        var setDefault = ButtonOf("Set Default", Color.White, Color.FromArgb(30, 64, 175));
        var remove = ButtonOf("Remove", Color.White, Color.FromArgb(185, 28, 28));
        var refresh = ButtonOf("Refresh", Color.White, Color.FromArgb(51, 65, 85));
        add.Click += delegate { AddProject(); };
        setDefault.Click += delegate { SetDefaultProject(); };
        remove.Click += delegate { RemoveProject(); };
        refresh.Click += delegate { RefreshProjects(); };
        actions.Controls.Add(add);
        actions.Controls.Add(setDefault);
        actions.Controls.Add(remove);
        actions.Controls.Add(refresh);
        page.Controls.Add(actions);

        projectsGrid = new DataGridView
        {
            Dock = DockStyle.Fill,
            BackgroundColor = Color.White,
            BorderStyle = BorderStyle.FixedSingle,
            AutoGenerateColumns = false,
            AllowUserToAddRows = false,
            AllowUserToDeleteRows = false,
            ReadOnly = true,
            SelectionMode = DataGridViewSelectionMode.FullRowSelect,
            MultiSelect = false,
            RowHeadersVisible = false
        };
        projectsGrid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "State", Width = 95 });
        projectsGrid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "Project", Width = 230 });
        projectsGrid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "Workspace", AutoSizeMode = DataGridViewAutoSizeColumnMode.Fill });
        projectsGrid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText = "Permissions", Width = 245 });
        page.Controls.Add(projectsGrid);
        projectsGrid.BringToFront();
        return page;
    }

    private TabPage BuildLogs()
    {
        var page = NewPage("Logs");
        var actions = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 56, Padding = new Padding(6, 9, 0, 6) };
        var refresh = ButtonOf("Refresh Logs", Color.FromArgb(37, 99, 235), Color.White);
        var open = ButtonOf("Open Runtime Folder", Color.White, Color.FromArgb(51, 65, 85));
        refresh.Click += delegate { RefreshLogs(); };
        open.Click += delegate { OpenFolder(runtimeDir); };
        actions.Controls.Add(refresh);
        actions.Controls.Add(open);
        page.Controls.Add(actions);

        logs = new TextBox
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            ScrollBars = ScrollBars.Both,
            ReadOnly = true,
            WordWrap = false,
            Font = new Font("Consolas", 9F),
            BackColor = Color.FromArgb(15, 23, 42),
            ForeColor = Color.FromArgb(226, 232, 240)
        };
        page.Controls.Add(logs);
        logs.BringToFront();
        return page;
    }

    private TabPage BuildSettings()
    {
        var page = NewPage("Settings");
        var panel = new TableLayoutPanel { Dock = DockStyle.Top, Height = 410, ColumnCount = 2, RowCount = 7, Padding = new Padding(18) };
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 190));
        panel.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        workspaceBox = AddTextSetting(panel, 0, "Default workspace");
        portBox = new NumericUpDown { Minimum = 1, Maximum = 65535, Value = 1167, Dock = DockStyle.Top };
        AddSetting(panel, 1, "Local MCP port", portBox);
        aliasBox = AddTextSetting(panel, 2, "Tunnel alias");
        tunnelBox = AddTextSetting(panel, 3, "Tunnel ID");
        keyBox = AddTextSetting(panel, 4, "Runtime API key");
        keyBox.UseSystemPasswordChar = true;

        panel.Controls.Add(new Label(), 0, 5);
        panel.Controls.Add(new Label
        {
            Text = "Runtime API key is optional here. If entered, it is encrypted with Windows DPAPI under .runtime and never written to .env.",
            Dock = DockStyle.Fill,
            ForeColor = Color.FromArgb(100, 116, 139)
        }, 1, 5);

        var actions = new FlowLayoutPanel { Dock = DockStyle.Fill };
        var save = ButtonOf("Save Settings", Color.FromArgb(37, 99, 235), Color.White);
        var reset = ButtonOf("Reset Saved Key", Color.White, Color.FromArgb(185, 28, 28));
        var rebuild = ButtonOf("Rebuild App", Color.White, Color.FromArgb(51, 65, 85));
        save.Click += delegate { SaveSettings(); };
        reset.Click += delegate { RunCli("--reset-key", "Removing saved Runtime API key..."); };
        rebuild.Click += delegate { RebuildApp(); };
        actions.Controls.Add(save);
        actions.Controls.Add(reset);
        actions.Controls.Add(rebuild);
        panel.Controls.Add(new Label(), 0, 6);
        panel.Controls.Add(actions, 1, 6);

        page.Controls.Add(panel);
        return page;
    }

    private TabPage NewPage(string text)
    {
        return new TabPage(text) { BackColor = Color.FromArgb(245, 247, 251), Padding = new Padding(12) };
    }

    private Button ButtonOf(string text, Color back, Color fore)
    {
        return new Button
        {
            Text = text,
            AutoSize = true,
            MinimumSize = new Size(104, 34),
            Height = 34,
            FlatStyle = FlatStyle.Flat,
            BackColor = back,
            ForeColor = fore,
            Padding = new Padding(10, 0, 10, 0),
            Margin = new Padding(0, 0, 10, 0)
        };
    }

    private Label AddCard(TableLayoutPanel grid, int col, int row, string caption)
    {
        var card = new Panel { Dock = DockStyle.Fill, BackColor = Color.White, Margin = new Padding(7), Padding = new Padding(18) };
        card.Controls.Add(new Label
        {
            Text = caption,
            ForeColor = Color.FromArgb(100, 116, 139),
            Font = new Font("Segoe UI Semibold", 8.5F, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(18, 16)
        });
        var value = new Label
        {
            Text = "—",
            ForeColor = Color.FromArgb(15, 23, 42),
            Font = new Font("Segoe UI Semibold", 13.5F, FontStyle.Bold),
            AutoEllipsis = true,
            AutoSize = false,
            Height = 52,
            Location = new Point(18, 46),
            Width = 430
        };
        card.Resize += delegate { value.Width = card.ClientSize.Width - 36; };
        card.Controls.Add(value);
        grid.Controls.Add(card, col, row);
        return value;
    }

    private void AddDesktopCard(TableLayoutPanel grid, int col, int row)
    {
        var card = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(239, 246, 255), Margin = new Padding(7), Padding = new Padding(18) };
        card.Controls.Add(new Label
        {
            Text = "DESKTOP MODE",
            ForeColor = Color.FromArgb(30, 64, 175),
            Font = new Font("Segoe UI Semibold", 8.5F, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(18, 16)
        });
        card.Controls.Add(new Label
        {
            Text = "localhost stays in the background.\r\nThe browser opens only when you click Open Web Console.",
            ForeColor = Color.FromArgb(30, 64, 175),
            AutoSize = false,
            Size = new Size(440, 60),
            Location = new Point(18, 44)
        });
        grid.Controls.Add(card, col, row);
    }

    private TextBox AddTextSetting(TableLayoutPanel panel, int row, string label)
    {
        var box = new TextBox { Dock = DockStyle.Top };
        AddSetting(panel, row, label, box);
        return box;
    }

    private void AddSetting(TableLayoutPanel panel, int row, string label, Control control)
    {
        panel.RowStyles.Add(new RowStyle(SizeType.Absolute, row == 5 ? 60 : 48));
        panel.Controls.Add(new Label
        {
            Text = label,
            Dock = DockStyle.Fill,
            ForeColor = Color.FromArgb(51, 65, 85),
            Padding = new Padding(0, 5, 12, 0)
        }, 0, row);
        panel.Controls.Add(control, 1, row);
    }

    private void LoadSettings()
    {
        var env = ReadEnv(envPath);
        string workspace = Env(env, "VIBECODE_WORKSPACE");
        string port = Env(env, "VIBECODE_PORT");
        string alias = Env(env, "TUNNEL_ALIAS");
        string tunnel = Env(env, "CONTROL_PLANE_TUNNEL_ID");

        workspaceBox.Text = String.IsNullOrWhiteSpace(workspace) || workspace.IndexOf("your-project", StringComparison.OrdinalIgnoreCase) >= 0 ? root : workspace;
        int p;
        if (!Int32.TryParse(port, out p) || p < 1 || p > 65535) p = 1167;
        portBox.Value = p;
        aliasBox.Text = String.IsNullOrWhiteSpace(alias) ? "vibecode-local" : alias;
        tunnelBox.Text = tunnel ?? "";
        baseUrl = "http://127.0.0.1:" + p;
    }

    private void SaveSettings()
    {
        try
        {
            string workspace = workspaceBox.Text.Trim();
            if (!Directory.Exists(workspace)) throw new Exception("Workspace does not exist.");
            int port = Decimal.ToInt32(portBox.Value);
            string alias = String.IsNullOrWhiteSpace(aliasBox.Text) ? "vibecode-local" : aliasBox.Text.Trim();

            var sb = new StringBuilder();
            sb.AppendLine("# Non-secret launcher/runtime configuration.");
            sb.AppendLine("# Runtime API key is stored separately with Windows DPAPI in .runtime.");
            sb.AppendLine("VIBECODE_WORKSPACE=" + EnvValue(workspace));
            sb.AppendLine("VIBECODE_HOST=127.0.0.1");
            sb.AppendLine("VIBECODE_PORT=" + port);
            sb.AppendLine("CONTROL_PLANE_TUNNEL_ID=" + EnvValue(tunnelBox.Text.Trim()));
            sb.AppendLine("TUNNEL_ALIAS=" + EnvValue(alias));
            sb.AppendLine("VIBECODE_SHELL_MODE=allowlist");
            sb.AppendLine("VIBECODE_ALLOW_DANGEROUS=0");
            sb.AppendLine("VIBECODE_BROWSER_ALLOW_EXTERNAL=0");
            sb.AppendLine("VIBECODE_MAX_READ_BYTES=262144");
            sb.AppendLine("VIBECODE_MAX_COMMAND_OUTPUT_BYTES=262144");
            File.WriteAllText(envPath, sb.ToString(), new UTF8Encoding(false));

            if (!String.IsNullOrWhiteSpace(keyBox.Text))
            {
                Directory.CreateDirectory(runtimeDir);
                byte[] entropy = Encoding.UTF8.GetBytes("vibecode-mcp-secure-launcher-v1");
                byte[] clear = Encoding.UTF8.GetBytes(keyBox.Text);
                byte[] enc = ProtectedData.Protect(clear, entropy, DataProtectionScope.CurrentUser);
                Array.Clear(clear, 0, clear.Length);
                File.WriteAllBytes(Path.Combine(runtimeDir, "launcher-runtime-key.dpapi"), enc);
                keyBox.Text = "";
            }

            baseUrl = "http://127.0.0.1:" + port;
            MessageBox.Show(this, "Settings saved. Use Restart to apply runtime changes.", "Vibecode MCP", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "Settings", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private void RefreshAll(bool withProjects)
    {
        if (busy) return;
        try
        {
            var data = JsonGet(baseUrl + "/api/status");
            statusPill.Text = "● Online";
            statusPill.ForeColor = Color.FromArgb(74, 222, 128);
            mcpValue.Text = "Healthy";

            var runtime = Obj(data, "runtime");
            var tunnel = Obj(data, "tunnel");
            var git = Obj(data, "git");
            var security = Obj(data, "security");
            var processes = Obj(data, "processes");
            var def = Obj(data, "defaultProject");
            if (def.Count == 0) def = Obj(data, "activeProject");

            endpointValue.Text = "http://" + Str(runtime, "host", "127.0.0.1") + ":" + Str(runtime, "port", "1167") + "/mcp";
            tunnelValue.Text = Str(tunnel, "runtimeStatus", "unknown");
            projectValue.Text = Str(def, "name", Str(data, "workspace", "—"));
            gitValue.Text = Bool(git, "available") ? Str(git, "branch", "—") + " · " + (Bool(git, "clean") ? "clean" : Str(git, "changedFiles", "0") + " changed") : "Not a Git repo";
            securityValue.Text = Str(security, "level", "unknown");
            processValue.Text = Str(processes, "running", "0") + " running · " + Str(processes, "exited", "0") + " exited";
            footer.Text = "Backend " + endpointValue.Text + " · Tunnel " + tunnelValue.Text;
            refreshed.Text = "Updated " + DateTime.Now.ToString("HH:mm:ss");

            if (withProjects) RefreshProjects();
        }
        catch
        {
            statusPill.Text = "● Offline";
            statusPill.ForeColor = Color.FromArgb(248, 113, 113);
            mcpValue.Text = "Offline";
            tunnelValue.Text = "Unknown";
            footer.Text = "MCP backend is not reachable.";
        }
    }

    private void RefreshProjects()
    {
        try
        {
            var data = JsonGet(baseUrl + "/api/projects");
            object raw;
            if (!data.TryGetValue("projects", out raw)) return;
            object[] items = raw as object[];
            if (items == null) return;

            projectsGrid.Rows.Clear();
            foreach (object item in items)
            {
                var p = item as Dictionary<string, object>;
                if (p == null) continue;
                bool isDefault = Bool(p, "default") || Bool(p, "active");
                int i = projectsGrid.Rows.Add(isDefault ? "DEFAULT" : "ENABLED", Str(p, "name", "—"), Str(p, "workspace", "—"), Permissions(p));
                projectsGrid.Rows[i].Tag = p;
            }
        }
        catch (Exception ex) { footer.Text = "Projects: " + ex.Message; }
    }

    private string Permissions(Dictionary<string, object> p)
    {
        var perms = Obj(p, "permissions");
        var list = new List<string>();
        foreach (string key in new[] { "read", "write", "execute", "process", "gitWrite", "browser", "delete" })
            if (Bool(perms, key)) list.Add(key);
        return String.Join(" · ", list.ToArray());
    }

    private Dictionary<string, object> SelectedProject()
    {
        if (projectsGrid.CurrentRow == null) return null;
        return projectsGrid.CurrentRow.Tag as Dictionary<string, object>;
    }

    private void AddProject()
    {
        using (var dlg = new FolderBrowserDialog())
        {
            dlg.Description = "Select project workspace";
            dlg.ShowNewFolderButton = false;
            if (dlg.ShowDialog(this) != DialogResult.OK) return;
            string workspace = dlg.SelectedPath;
            string name = Path.GetFileName(workspace.TrimEnd(Path.DirectorySeparatorChar));
            try
            {
                Request(baseUrl + "/api/projects", "POST", "{\"name\":" + JsonString(name) + ",\"workspace\":" + JsonString(workspace) + "}");
                RefreshProjects();
            }
            catch (Exception ex) { MessageBox.Show(this, ex.Message, "Add Project", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        }
    }

    private void SetDefaultProject()
    {
        var p = SelectedProject();
        if (p == null) return;
        string id = Str(p, "id", "");
        try
        {
            try { Request(baseUrl + "/api/projects/" + Uri.EscapeDataString(id) + "/default", "POST", "{}"); }
            catch { Request(baseUrl + "/api/projects/" + Uri.EscapeDataString(id) + "/activate", "POST", "{}"); }
            RefreshProjects();
            RefreshAll(false);
        }
        catch (Exception ex) { MessageBox.Show(this, ex.Message, "Set Default", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    private void RemoveProject()
    {
        var p = SelectedProject();
        if (p == null) return;
        if (Bool(p, "default") || Bool(p, "active"))
        {
            MessageBox.Show(this, "Set another DEFAULT project first.", "Remove Project", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        string name = Str(p, "name", "project");
        if (MessageBox.Show(this, "Remove " + name + " from registry? Files on disk are not deleted.", "Remove Project", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
        try
        {
            Request(baseUrl + "/api/projects/" + Uri.EscapeDataString(Str(p, "id", "")), "DELETE", null);
            RefreshProjects();
        }
        catch (Exception ex) { MessageBox.Show(this, ex.Message, "Remove Project", MessageBoxButtons.OK, MessageBoxIcon.Error); }
    }

    private void RefreshLogs()
    {
        var sb = new StringBuilder();
        sb.AppendLine("=== MCP STDOUT ===");
        sb.AppendLine(Tail(Path.Combine(runtimeDir, "mcp.stdout.log"), 160));
        sb.AppendLine();
        sb.AppendLine("=== MCP STDERR ===");
        sb.AppendLine(Tail(Path.Combine(runtimeDir, "mcp.stderr.log"), 160));
        sb.AppendLine();
        sb.AppendLine("=== SERVER 1167 STDERR ===");
        sb.AppendLine(Tail(Path.Combine(runtimeDir, "server-1167.stderr.log"), 120));
        logs.Text = sb.ToString();
        logs.SelectionStart = logs.TextLength;
        logs.ScrollToCaret();
    }

    private void RunCli(string args, string message)
    {
        if (busy) return;
        busy = true;
        SetButtons(false);
        footer.Text = message;

        ThreadPool.QueueUserWorkItem(delegate
        {
            string output = "";
            int code = -1;
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = cliPath,
                    Arguments = args,
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                using (var p = Process.Start(psi))
                {
                    output = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
                    p.WaitForExit();
                    code = p.ExitCode;
                }
            }
            catch (Exception ex) { output = ex.ToString(); }

            BeginInvoke((MethodInvoker)delegate
            {
                busy = false;
                SetButtons(true);
                footer.Text = code == 0 ? "Operation completed." : "Operation failed.";
                if (code != 0) MessageBox.Show(this, output, "Vibecode MCP", MessageBoxButtons.OK, MessageBoxIcon.Error);
                RefreshAll(true);
                RefreshLogs();
            });
        });
    }

    private void RestartAll()
    {
        if (busy) return;
        busy = true;
        SetButtons(false);
        footer.Text = "Restarting MCP + Tunnel...";

        ThreadPool.QueueUserWorkItem(delegate
        {
            string error = null;
            try
            {
                RunProcess(cliPath, "--stop", 45000);
                Thread.Sleep(500);
                RunProcess(cliPath, "--no-open", 90000);
            }
            catch (Exception ex) { error = ex.Message; }

            BeginInvoke((MethodInvoker)delegate
            {
                busy = false;
                SetButtons(true);
                if (error != null) MessageBox.Show(this, error, "Restart", MessageBoxButtons.OK, MessageBoxIcon.Error);
                RefreshAll(true);
                RefreshLogs();
            });
        });
    }

    private void RebuildApp()
    {
        if (busy) return;
        busy = true;
        SetButtons(false);
        footer.Text = "Rebuilding Windows app...";

        ThreadPool.QueueUserWorkItem(delegate
        {
            string error = null;
            try { RunProcess("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -File \"scripts\\Build-WindowsLauncher.ps1\"", 120000); }
            catch (Exception ex) { error = ex.Message; }

            BeginInvoke((MethodInvoker)delegate
            {
                busy = false;
                SetButtons(true);
                if (error == null) MessageBox.Show(this, "Build completed. Restart the app to use the rebuilt EXE.", "Build", MessageBoxButtons.OK, MessageBoxIcon.Information);
                else MessageBox.Show(this, error, "Build", MessageBoxButtons.OK, MessageBoxIcon.Error);
            });
        });
    }

    private void RunProcess(string file, string args, int timeoutMs)
    {
        var psi = new ProcessStartInfo
        {
            FileName = file,
            Arguments = args,
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        using (var p = Process.Start(psi))
        {
            string stdout = p.StandardOutput.ReadToEnd();
            string stderr = p.StandardError.ReadToEnd();
            if (!p.WaitForExit(timeoutMs))
            {
                try { p.Kill(); } catch { }
                throw new Exception("Process timed out.");
            }
            if (p.ExitCode != 0) throw new Exception((stderr + "\r\n" + stdout).Trim());
        }
    }

    private void SetButtons(bool enabled)
    {
        startButton.Enabled = enabled;
        stopButton.Enabled = enabled;
        restartButton.Enabled = enabled;
        refreshButton.Enabled = enabled;
    }

    private Dictionary<string, object> JsonGet(string url)
    {
        using (var wc = new TimeoutWebClient { TimeoutMs = 1800 })
        {
            wc.Encoding = Encoding.UTF8;
            return json.DeserializeObject(wc.DownloadString(url)) as Dictionary<string, object>;
        }
    }

    private string Request(string url, string method, string body)
    {
        var req = (HttpWebRequest)WebRequest.Create(url);
        req.Method = method;
        req.Timeout = 3500;
        req.ReadWriteTimeout = 3500;
        req.Proxy = null;
        req.ContentType = "application/json";
        if (body != null)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(body);
            req.ContentLength = bytes.Length;
            using (var stream = req.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
        }
        using (var res = (HttpWebResponse)req.GetResponse())
        using (var reader = new StreamReader(res.GetResponseStream()))
            return reader.ReadToEnd();
    }

    private static Dictionary<string, object> Obj(Dictionary<string, object> source, string key)
    {
        if (source == null) return new Dictionary<string, object>();
        object value;
        if (!source.TryGetValue(key, out value) || value == null) return new Dictionary<string, object>();
        return value as Dictionary<string, object> ?? new Dictionary<string, object>();
    }

    private static string Str(Dictionary<string, object> source, string key, string fallback)
    {
        if (source == null) return fallback;
        object value;
        if (!source.TryGetValue(key, out value) || value == null) return fallback;
        return Convert.ToString(value);
    }

    private static bool Bool(Dictionary<string, object> source, string key)
    {
        if (source == null) return false;
        object value;
        if (!source.TryGetValue(key, out value) || value == null) return false;
        if (value is bool) return (bool)value;
        bool parsed;
        return Boolean.TryParse(Convert.ToString(value), out parsed) && parsed;
    }

    private static string JsonString(string value)
    {
        return "\"" + (value ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    private static string Tail(string path, int maxLines)
    {
        if (!File.Exists(path)) return "(not found)";
        string[] lines = File.ReadAllLines(path);
        int start = Math.Max(0, lines.Length - maxLines);
        return String.Join(Environment.NewLine, lines, start, lines.Length - start);
    }

    private static Dictionary<string, string> ReadEnv(string path)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!File.Exists(path)) return result;
        foreach (string raw in File.ReadAllLines(path))
        {
            string line = raw.Trim();
            if (line.Length == 0 || line.StartsWith("#")) continue;
            int idx = line.IndexOf('=');
            if (idx < 1) continue;
            string key = line.Substring(0, idx).Trim();
            string value = line.Substring(idx + 1).Trim().Trim('"').Trim('\'');
            result[key] = value;
        }
        return result;
    }

    private static string Env(Dictionary<string, string> env, string key)
    {
        string value;
        return env.TryGetValue(key, out value) ? value : null;
    }

    private static string EnvValue(string value)
    {
        if (value == null) return "";
        if (value.IndexOf(' ') >= 0 || value.IndexOf('#') >= 0) return "\"" + value.Replace("\"", "") + "\"";
        return value;
    }

    private static void OpenUrl(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    private static void OpenFolder(string path)
    {
        try
        {
            Directory.CreateDirectory(path);
            Process.Start(new ProcessStartInfo("explorer.exe", "\"" + path + "\"") { UseShellExecute = true });
        }
        catch { }
    }

    private void RestoreFromTray()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }
}
