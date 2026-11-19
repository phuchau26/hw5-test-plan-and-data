# HW05 k6 Test Plans and Safe Test Data

Repository này chỉ công bố source của test plan k6 và test data an toàn cho HW05. Đây **không phải** toàn bộ bài nộp HW05, không chứa raw metrics, HTML report, screenshot, SQLite database, credentials thật, JWT, `.env`, hoặc lịch sử thực hiện bài. Bài nộp đầy đủ được giữ trong ZIP Moodle riêng.

## Nội dung

- `test-plans/23120252_Load_20261117.js`: Load Test 10 VU.
- `test-plans/23120252_Stress_20261117.js`: Stress Test theo các plateau 10/20/30/40 VU.
- `test-plans/23120252_Spike_20261118.js`: Spike Test 10 → 40 → 10 VU.
- `test-plans/lib/eshop-workflow.js`: workflow dùng chung: Login → Search Products → Product Detail → Add to Cart → Checkout → Order History.
- `test-data/`: product fixture, schema, data contract và ví dụ account không nhạy cảm.

Các file `.design.md` mô tả workload và safety guardrail đã dùng trong HW05. Các script vẫn giữ nguyên logic gốc và sử dụng `RUN_ID` để tránh ghi đè summary.

## Điều kiện trước khi chạy

1. Cài Grafana k6 tương thích với `k6/data`, `k6/execution` và `k6/metrics`.
2. Chuẩn bị backend EShop do bạn sở hữu/quản lý và chỉ chạy khi đã có quyền kiểm thử.
3. Tạo account test cô lập; không dùng account thật hoặc account của người khác.
4. Tạo file local **không commit** tại `test-data/`:

   - `credentials.local.csv` cho Load: tối thiểu 10 hàng khác nhau, có header `username,password,shipping_address`.
   - `stress_accounts.local.csv` cho Stress và Spike: tối thiểu 40 hàng khác nhau, cùng header.

`test-data/credentials.csv`, `stress_accounts.example.csv` và `spike_accounts.example.csv` chỉ là schema/example an toàn. Thay placeholder bằng dữ liệu local của bạn; các file `*.local.csv` đã bị `.gitignore` loại trừ.

## Kiểm tra cấu trúc dữ liệu

Mỗi VU dùng account riêng theo ánh xạ 1:1. Cần tối thiểu một product hợp lệ trong `test-data/products.csv`. Workflow yêu cầu trường `username`, `password` và `shipping_address`; account thiếu hoặc lặp sẽ làm script dừng trước khi gửi tải.

## Lệnh chạy minh họa

Chạy từ repository root sau khi tạo các thư mục output và đã kiểm tra backend/local data. Thay `BASE_URL` và `RUN_ID` bằng môi trường của bạn.

```bash
mkdir -p results/raw-k6 results/k6-summary results/html-reports
export RUN_ID=local_$(date +%Y%m%d_%H%M%S)
export BASE_URL=http://localhost:3000
export OUTPUT_DIR=results
k6 run --out json="results/raw-k6/load_${RUN_ID}.json" test-plans/23120252_Load_20261117.js
```

Không chạy Load/Stress/Spike vào production, và không xem các ngưỡng trong script là capacity limit hoặc production SLO.

## Ghi chú bảo mật và provenance

- Không đưa credentials, token, database, raw metrics, screenshot hoặc report đã chạy vào repository này.
- Các script có cơ chế abort khi xác thực lỗi để giảm nguy cơ vòng lặp 401/account lockout.
- Kết quả, evidence và Git history của bài HW05 gốc không được sao chép sang repository public này.
