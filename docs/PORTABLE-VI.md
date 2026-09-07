# Vibecode MCP Secure — bản portable

## Chạy ngay

1. Giải nén toàn bộ file ZIP vào một thư mục có quyền ghi, ví dụ `D:\Tools\VibecodeMCP`.
2. Bấm đúp `RUN-Vibecode-MCP.cmd`.
3. Cửa sổ CLI tự khởi động MCP local. Web Console ở `http://127.0.0.1:1167`.

Node.js, tunnel client, dependencies và Chromium cho các công cụ `browser_*` đã nằm trong gói. Không cần chạy `npm install` hay cài Node.js.

## Kết nối Secure MCP Tunnel lần đầu

Portable package cố ý không chứa runtime API key hoặc cấu hình tunnel của máy đóng gói. Chạy `VibecodeMCP.Cli.exe --configure` một lần để nhập workspace, tunnel ID và Runtime API key. Key được mã hóa bằng Windows DPAPI cho đúng tài khoản Windows hiện tại.

## Dừng dịch vụ

Bấm **Stop** trong ứng dụng, hoặc chạy `STOP-Vibecode-MCP.cmd`.

## Lưu ý

- Giữ nguyên cấu trúc thư mục sau khi giải nén; không chỉ chép mỗi file `.exe`.
- Cổng mặc định là `1167`. Nếu đã có dịch vụ khác dùng cổng này, đổi port trong tab **Settings** trước khi chạy lại.
- `.runtime` và `.env` được tạo tại nơi giải nén; chúng chứa trạng thái/cấu hình riêng của máy và không nên sao chép để chia sẻ.
