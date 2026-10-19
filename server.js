<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>จองห้องประชุม</title>
  <script charset="utf-8" src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
  <style>
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background-color: #f4f6f8; margin: 0; padding: 16px; display: flex; justify-content: center; }
    .card { background: #ffffff; border-radius: 12px; padding: 20px; width: 100%; max-width: 480px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
    h2 { margin-top: 0; color: #111; font-size: 20px; }
    .user-info { font-size: 13px; color: #555; margin-bottom: 16px; }
    .form-group { margin-bottom: 14px; }
    label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 6px; color: #333; }
    input, select { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; background: #fff; }
    input:focus, select:focus { outline: none; border-color: #00B900; }
    .row { display: flex; gap: 10px; }
    .row > div { flex: 1; }
    button { width: 100%; padding: 12px; background-color: #00B900; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: bold; cursor: pointer; margin-top: 8px; }
    button:disabled { background-color: #9cd4a7; cursor: not-allowed; }
  </style>
</head>
<body>

<div class="card">
  <h2>จองห้องประชุม</h2>
  <div id="user-display" class="user-info">กำลังเชื่อมต่อ LINE...</div>

  <form id="bookingForm">
    <div class="form-group">
      <label for="title">หัวข้อการประชุม</label>
      <input type="text" id="title" placeholder="เช่น ประชุมวางแผนทีม" required>
    </div>

    <div class="form-group">
      <label for="room_id">เลือกห้องประชุม</label>
      <select id="room_id" required>
        <option value="R1">ห้องทุ่งรวงเงิน (ห้องเล็ก)</option>
        <option value="R2">ห้องทุ่งรวงทอง (ห้องใหญ่)</option>
        <option value="R_ALL">ห้องทุ่งประกายเพชร (รวม 1+2)</option>
      </select>
    </div>

    <div class="form-group">
      <label for="booking_date">วันที่</label>
      <input type="date" id="booking_date" required>
    </div>

    <div class="row form-group">
      <div>
        <label for="start_time_select">เวลาเริ่ม (24 ชม.)</label>
        <select id="start_time_select" required>
          <option value="">-- เลือก --</option>
        </select>
      </div>
      <div>
        <label for="end_time_select">เวลาสิ้นสุด (24 ชม.)</label>
        <select id="end_time_select" required>
          <option value="">-- เลือก --</option>
        </select>
      </div>
    </div>

    <button type="submit" id="submitBtn">ยืนยันการจอง</button>
  </form>
</div>

<script>
  const MY_LIFF_ID = "2012070438-neRmVlKc";
  let userProfile = null;

  // 1. สร้างตัวเลือกเวลา 08:00 - 20:00 น. (นาที 00 และ 30)
  function populateTimeOptions() {
    const startSelect = document.getElementById('start_time_select');
    const endSelect = document.getElementById('end_time_select');
    const times = [];

    for (let h = 8; h <= 20; h++) {
      const hh = String(h).padStart(2, '0');
      times.push(`${hh}:00`);
      if (h < 20) {
        times.push(`${hh}:30`);
      }
    }

    times.forEach(t => {
      startSelect.add(new Option(`${t} น.`, t));
      endSelect.add(new Option(`${t} น.`, t));
    });
  }

  // กำหนดวันปัจจุบันให้เป็นค่าเริ่มต้น
  function setDefaultDate() {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    document.getElementById('booking_date').value = today;
  }

  // 2. เริ่มต้น LIFF
  async function initLiff() {
    try {
      await liff.init({ liffId: MY_LIFF_ID });
      if (liff.isLoggedIn()) {
        userProfile = await liff.getProfile();
        document.getElementById('user-display').innerText = `👤 ผู้จอง: "${userProfile.displayName}"`;
      } else {
        liff.login();
      }
    } catch (err) {
      document.getElementById('user-display').innerText = `เข้าสู่ระบบ LINE ไม่สำเร็จ: ${err.message}`;
    }
  }

  // 3. จัดการการ Submit จองห้อง
  document.getElementById('bookingForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const bookingDate = document.getElementById('booking_date').value;
    const startTimeVal = document.getElementById('start_time_select').value;
    const endTimeVal = document.getElementById('end_time_select').value;

    if (!startTimeVal || !endTimeVal) {
      alert('กรุณาเลือกเวลาเริ่มและเวลาสิ้นสุด');
      return;
    }

    if (startTimeVal >= endTimeVal) {
      alert('เวลาสิ้นสุดต้องมากกว่าเวลาเริ่มต้น');
      return;
    }

    // ล็อก Timezone ประเทศไทย (+07:00) ให้กับ ISO String เสมอ
    const fullStartTime = `${bookingDate}T${startTimeVal}:00+07:00`;
    const fullEndTime = `${bookingDate}T${endTimeVal}:00+07:00`;

    const btn = document.getElementById('submitBtn');
    btn.disabled = true;
    btn.innerText = 'กำลังตรวจสอบห้อง...';

    const payload = {
      user_line_id: userProfile ? userProfile.userId : 'TEST_USER',
      user_name: userProfile ? userProfile.displayName : 'ผู้ใช้ LINE',
      room_id: document.getElementById('room_id').value,
      title: document.getElementById('title').value,
      start_time: fullStartTime,
      end_time: fullEndTime
    };

    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'เกิดข้อผิดพลาดในการจอง');
      } else {
        alert('✅ จองห้องประชุมสำเร็จเรียบร้อยแล้ว');
        if (typeof liff !== 'undefined' && liff.closeWindow) {
          liff.closeWindow();
        }
      }
    } catch (err) {
      alert('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
    } finally {
      btn.disabled = false;
      btn.innerText = 'ยืนยันการจอง';
    }
  });

  populateTimeOptions();
  setDefaultDate();
  initLiff();
</script>

</body>
</html>
