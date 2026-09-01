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

Script sẽ lần lượt chạy Setup → Configure → Start.

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

Key này chỉ được nhập lúc chạy và không được ghi vào `.env`.

## 3) Kiểm tra MCP local

Sau khi start thành công:

```text
Control Center: http://127.0.0.1:7317/
Health:         http://127.0.0.1:7317/healthz
Ready:          http://127.0.0.1:7317/readyz
MCP endpoint:   http://127.0.0.1:7317/mcp
```

Nếu có lỗi, chạy:

```text
DOCTOR.cmd
```

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

Start:

```text
START.cmd
```

Diagnose:

```text
DOCTOR.cmd
```

Stop:

```text
STOP.cmd
```

Nếu đổi project được phép thao tác:

```text
CONFIGURE.cmd
```

## 7) Tool chính đã có

- Files/context: read_file, read_range, write_file, apply_patch, tree, search_text, repo_map
- Execution: run_command, start_process, process_list, process_logs, stop_process
- Git: git_status, git_diff, git_log, git_add, git_commit, git_restore
- Verification: verify_project
- Browser: open/click/fill/snapshot/screenshot/close
- Observability: health, project_info, audit_tail

## 8) Giới hạn của bản bridge-ready

Bản này phù hợp để vibecode trên máy cá nhân/repo tin cậy. Nó chưa phải hardened multi-user/24x7 production service. Đặc biệt chưa có canonical symlink/junction sandbox, local MCP auth v2, persistent process recovery, audit hash-chain và full security test suite.

Để an toàn, giữ mặc định:

```text
VIBECODE_HOST=127.0.0.1
VIBECODE_SHELL_MODE=allowlist
VIBECODE_ALLOW_DANGEROUS=0
VIBECODE_BROWSER_ALLOW_EXTERNAL=0
```
