# Vibecode MCP Bridge-Ready — Hướng dẫn nhanh

Bản này dành cho **local/personal development** theo kiến trúc:

ChatGPT Web → OpenAI Secure MCP Tunnel → MCP local → project trên Windows.

## 1) Yêu cầu

- Windows 10/11
- Git
- Node.js 20+
- Quyền sử dụng Secure MCP Tunnel trong OpenAI workspace

Kiểm tra nhanh trong PowerShell:

```powershell
node -v
git --version
```

## 2) Chạy lần đầu

Giải nén ZIP vào ví dụ:

```text
C:\vibecode-mcp-secure
```

Sau đó double-click:

```text
FIRST-RUN.cmd
```

Script sẽ chạy Setup → cấu hình launcher → start. Sau lần đầu, chỉ cần double-click `START.cmd`.

### Khi Configure hỏi workspace

Nhập project mà ChatGPT được phép thao tác, ví dụ:

```text
E:\kpi-performance-starter
```

### Khi Configure hỏi tunnel_id

Tạo tunnel trong OpenAI Platform Tunnels và nhập giá trị dạng:

```text
tunnel_...
```

Tunnel phải thuộc đúng ChatGPT workspace bạn sẽ dùng.

### Khi START hỏi Runtime API key

Dùng Restricted Runtime API key có quyền:

```text
Tunnels Read + Use
```

Key không được ghi vào `.env`. Với launcher CLI, key có thể được nhập một lần rồi lưu mã hóa bằng Windows DPAPI trong `.runtime`, chỉ tài khoản Windows hiện tại giải mã được.

### Launcher CLI

Sau khi SETUP xong, chạy:

```text
START.cmd
```

CLI sẽ start MCP và tunnel. Mở Control Center bằng trình duyệt tại `http://127.0.0.1:1167/` khi cần quản lý project hoặc xem trạng thái.

Các lệnh tiện dụng: `--status`, `--stop`, `--configure`, `--reset-key`, `--self-test`, `--no-open`.

## 3) Kiểm tra MCP local

Sau khi start thành công:

```text
Control Center: http://127.0.0.1:1167/
Health:         http://127.0.0.1:1167/healthz
Ready:          http://127.0.0.1:1167/readyz
MCP endpoint:   http://127.0.0.1:1167/mcp
```

Nếu có lỗi, chạy:

```text
DOCTOR.cmd
```

### macOS

Các file `.cmd` và `VibecodeMCP.Cli.exe` chỉ chạy trên Windows. Trên macOS, chạy lần đầu bằng `SETUP-MACOS.command` (có thể right-click → **Open** nếu Gatekeeper hỏi). Sau đó sửa `.env` với đường dẫn kiểu `/Users/ban/Projects/project` và tunnel ID. Mỗi lần khởi động dùng `START-MACOS.command`; script sẽ hỏi Runtime API key nhưng không lưu key vào `.env`. Dừng bằng `STOP-MACOS.command`.

Script setup macOS tự chọn `tunnel-client` cho Apple Silicon hoặc Intel, cài dependency và Chromium. Cần Node.js 20+.

## 4) Kết nối ChatGPT

Trong ChatGPT:

```text
Settings
→ Connectors / Apps
→ Add custom MCP connection
→ Connection: Tunnel
→ chọn tunnel hoặc paste cùng tunnel_id
```

Tunnel runtime trên máy phải đang chạy để ChatGPT discover và gọi tool.

## 5) Prompt test đầu tiên

Sau khi connector đã hiện trong ChatGPT, thử:

```text
Kiểm tra project hiện tại qua Vibecode MCP. Chỉ đọc, chưa sửa gì.
Hãy trả về:
1. workspace hiện tại
2. repo map
3. git status
4. package scripts
5. các lệnh verify có thể chạy
```

Nếu pass, thử vòng coding an toàn:

```text
Đọc AGENTS.md và PROJECT_SPEC.md trước.
Rà project, tìm một lỗi nhỏ hoặc warning không phá kiến trúc.
Lập plan ngắn, sửa bằng patch nhỏ nhất, chạy lint/typecheck/test/build phù hợp,
review git diff và báo kết quả. Không commit nếu tôi chưa yêu cầu.
```

## 6) Workflow dùng hằng ngày

Start (khuyến nghị):

```text
START.cmd
```

`START.cmd` tự gọi CLI nếu file tồn tại.

Diagnose:

```text
DOCTOR.cmd
```

Stop:

```text
STOP.cmd
```

Để thêm project hằng ngày, mở Control Center → **Projects** → **+ Add Project**. Có thể chọn ổ/thư mục, mở thư mục hoặc tạo thư mục mới trong ổ đã chọn. Tất cả project đã approve đều **ENABLED đồng thời**, nhưng mọi tool project-scoped phải truyền `projectId` rõ ràng — không có fallback nên không thể thao tác nhầm project. Mỗi project nhận một port plan `frontend` / `backend` / `worker`; các port này không trùng project khác hoặc port đang lắng nghe trên máy. `CONFIGURE.cmd` chỉ còn cần khi đổi cấu hình bootstrap như workspace ban đầu/tunnel.

## 7) Tool chính đã có

- Files/context: read_file, read_range, write_file, apply_patch, tree, search_text, repo_map
- Execution: run_command, start_process, process_list, process_logs, stop_process
- Git: git_status, git_diff, git_log, git_add, git_commit, git_restore
- Verification: verify_project
- Browser: open/click/fill/snapshot/screenshot/close
- Multi-Project Router: project_list; mọi tool project-scoped yêu cầu `projectId`
- Observability: health, project_info, audit_tail

## 8) Giới hạn của bản bridge-ready

Bản này phù hợp để vibecode trên máy cá nhân/repo tin cậy. Multi-Project Router hỗ trợ concurrent routing bằng `projectId`, per-project **tool-level permissions**, port plan không trùng lặp, canonical symlink/junction checks và audit content redaction đều có regression test. CLI watcher có thể tự khôi phục MCP khi listener biến mất; nó không thay thế process lạ đang chiếm port. Nó vẫn chưa phải hardened multi-user/24x7 production service; `Execute` vẫn chạy code với quyền Windows account, và còn thiếu OS sandbox/local MCP auth v2, audit hash-chain và full security test suite.

Để an toàn, giữ mặc định:

```text
VIBECODE_HOST=127.0.0.1
VIBECODE_SHELL_MODE=allowlist
VIBECODE_ALLOW_DANGEROUS=0
VIBECODE_BROWSER_ALLOW_EXTERNAL=0
```

> Router v4: MCP không có tool đổi ACTIVE/FALLBACK. Mọi project đã approve luôn ENABLED đồng thời; agent route trực tiếp bằng `projectId` bắt buộc.
