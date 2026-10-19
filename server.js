require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const line = require('@line/bot-sdk');
const path = require('path');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
};
const lineClient = new line.messagingApi.MessagingApiClient(lineConfig);

// รายชื่อ LINE User ID ของแอดมิน (ดึงจาก Render Environment)
const ADMIN_IDS = (process.env.ADMIN_LINE_IDS || '').split(',').map(id => id.trim()).filter(Boolean);

// รหัส PIN เข้าหน้าเว็บ Admin Dashboard (ค่าเริ่มต้น 1234 หากไม่ได้ตั้งใน Render)
const ADMIN_DASHBOARD_PIN = process.env.ADMIN_PIN || '1234';

const CONFLICT_RULES = {
  'R1': ['R1', 'R_ALL'],
  'R2': ['R2', 'R_ALL'],
  'R_ALL': ['R1', 'R2', 'R_ALL']
};

const ROOM_NAMES = {
  'R1': 'ห้องทุ่งรวงเงิน (ห้องเล็ก)',
  'R2': 'ห้องทุ่งรวงทอง (ห้องใหญ่)',
  'R_ALL': 'ห้องทุ่งประกายเพชร (รวม 1+2)'
};

// ฟังก์ชันดึงเวลา HH:mm แสดงผลตรงๆ โดยไม่โดน Timezone เลื่อน
function formatThaiTime(dateInput) {
  if (!dateInput) return '';
  const str = typeof dateInput === 'string' ? dateInput : dateInput.toISOString();
  const timePart = str.includes('T') ? str.split('T')[1] : str.split(' ')[1];
  return timePart.substring(0, 5);
}

// ฟังก์ชันจัดรูปแบบวันที่ภาษาไทย
function formatThaiDate(dateInput) {
  if (!dateInput) return '';
  const d = new Date(dateInput);
  return d.toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
}

// ----------------------------------------------------
// 1. Flex Message: ดูตารางห้องวันนี้ (สำหรับทุกคน)
// ----------------------------------------------------
async function getTodayScheduleFlex() {
  const query = `
    SELECT room_id, title, user_name, start_time, end_time
    FROM bookings
    WHERE status = 'confirmed'
      AND (start_time AT TIME ZONE 'Asia/Bangkok')::date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date
    ORDER BY start_time ASC;
  `;
  const result = await pool.query(query);
  const bookings = result.rows;

  const dateFormatted = new Date().toLocaleDateString('th-TH', { 
    dateStyle: 'medium', 
    timeZone: 'Asia/Bangkok' 
  });

  if (bookings.length === 0) {
    return {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '📅 ตารางห้องประชุมวันนี้', weight: 'bold', size: 'lg', color: '#1DB446' },
          { type: 'text', text: dateFormatted, size: 'xs', color: '#888888', margin: 'xs' },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '✨ วันนี้ยังไม่มีรายการจอง ว่างตลอดทั้งวันครับ', margin: 'lg', color: '#555555', wrap: true }
        ]
      }
    };
  }

  const contents = [
    { type: 'text', text: '📅 ตารางการจองวันนี้', weight: 'bold', size: 'lg', color: '#1DB446' },
    { type: 'text', text: dateFormatted, size: 'xs', color: '#888888', margin: 'xs' },
    { type: 'separator', margin: 'md' }
  ];

  bookings.forEach((b) => {
    const sTime = formatThaiTime(b.start_time);
    const eTime = formatThaiTime(b.end_time);

    contents.push({
      type: 'box',
      layout: 'vertical',
      margin: 'md',
      paddingAll: '8px',
      backgroundColor: '#F7F8F9',
      cornerRadius: '8px',
      contents: [
        { type: 'text', text: `${sTime} - ${eTime} น.`, weight: 'bold', size: 'sm', color: '#00B900' },
        { type: 'text', text: `📍 ${ROOM_NAMES[b.room_id] || b.room_id}`, size: 'xs', weight: 'bold', color: '#333333', margin: 'xs' },
        { type: 'text', text: `หัวข้อ: ${b.title}`, size: 'xs', color: '#555555' },
        { type: 'text', text: `ผู้จอง: ${b.user_name}`, size: 'xs', color: '#888888' }
      ]
    });
  });

  return {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: contents
    }
  };
}

// ----------------------------------------------------
// 2. Flex Message: ดูรายการจองของตนเองเพื่อยกเลิก (ยูสเซอร์ทั่วไป)
// ----------------------------------------------------
async function getMyBookingsFlex(userId) {
  const query = `
    SELECT id, room_id, title, start_time, end_time
    FROM bookings
    WHERE status = 'confirmed'
      AND user_line_id = $1
      AND end_time >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
    ORDER BY start_time ASC
    LIMIT 10;
  `;
  const result = await pool.query(query, [userId]);
  const bookings = result.rows;

  if (bookings.length === 0) {
    return {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '📋 รายการจองของคุณ', weight: 'bold', size: 'lg', color: '#00B900' },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: 'คุณไม่มีรายการจองห้องประชุมที่กำลังจะมาถึงครับ', margin: 'lg', color: '#666666', wrap: true }
        ]
      }
    };
  }

  const bubbles = bookings.map((b) => {
    const sTime = formatThaiTime(b.start_time);
    const eTime = formatThaiTime(b.end_time);
    const bDate = formatThaiDate(b.start_time);

    return {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '📌 การจองของคุณ', weight: 'bold', size: 'sm', color: '#1DB446' },
          { type: 'text', text: b.title, weight: 'bold', size: 'md', margin: 'sm' },
          { type: 'separator', margin: 'sm' },
          { type: 'text', text: `📍 ห้อง: ${ROOM_NAMES[b.room_id]}`, size: 'xs', color: '#444444', margin: 'sm' },
          { type: 'text', text: `📅 วันที่: ${bDate}`, size: 'xs', color: '#666666' },
          { type: 'text', text: `⏰ เวลา: ${sTime} - ${eTime} น.`, size: 'xs', color: '#666666' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            color: '#FF4B4B',
            height: 'sm',
            action: {
              type: 'postback',
              label: 'ยกเลิกการจองนี้',
              data: `action=cancel&booking_id=${b.id}`
            }
          }
        ]
      }
    };
  });

  return {
    type: 'carousel',
    contents: bubbles
  };
}

// ----------------------------------------------------
// 3. Flex Message: ดูรายการจองทั้งหมด (สำหรับ ADMIN เท่านั้น)
// ----------------------------------------------------
async function getAdminAllBookingsFlex() {
  const query = `
    SELECT id, room_id, title, user_name, start_time, end_time
    FROM bookings
    WHERE status = 'confirmed'
      AND end_time >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
    ORDER BY start_time ASC
    LIMIT 10;
  `;
  const result = await pool.query(query);
  const bookings = result.rows;

  if (bookings.length === 0) {
    return {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '🛡️ เมนูผู้ดูแลระบบ (Admin)', weight: 'bold', size: 'lg', color: '#0055FF' },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: 'ไม่มีรายการจองค้างอยู่ในระบบครับ', margin: 'lg', color: '#666666', wrap: true }
        ]
      }
    };
  }

  const bubbles = bookings.map((b) => {
    const sTime = formatThaiTime(b.start_time);
    const eTime = formatThaiTime(b.end_time);
    const bDate = formatThaiDate(b.start_time);

    return {
      type: 'bubble',
      size: 'kilo',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: '🛡️ จัดการการจอง (Admin)', weight: 'bold', size: 'sm', color: '#0055FF' },
          { type: 'text', text: b.title, weight: 'bold', size: 'md', margin: 'sm' },
          { type: 'separator', margin: 'sm' },
          { type: 'text', text: `👤 ผู้จอง: ${b.user_name}`, size: 'xs', weight: 'bold', color: '#333333', margin: 'sm' },
          { type: 'text', text: `📍 ห้อง: ${ROOM_NAMES[b.room_id]}`, size: 'xs', color: '#444444' },
          { type: 'text', text: `📅 วันที่: ${bDate}`, size: 'xs', color: '#666666' },
          { type: 'text', text: `⏰ เวลา: ${sTime} - ${eTime} น.`, size: 'xs', color: '#666666' }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            color: '#FF4B4B',
            height: 'sm',
            action: {
              type: 'postback',
              label: 'ยกเลิกคิวนี้ (Admin)',
              data: `action=admin_cancel&booking_id=${b.id}`
            }
          }
        ]
      }
    };
  });

  return {
    type: 'carousel',
    contents: bubbles
  };
}

// ----------------------------------------------------
// 4. Webhook จัดการ Event ของ LINE
// ----------------------------------------------------
app.post('/webhook', express.json(), async (req, res) => {
  res.status(200).send('OK');

  const events = req.body.events || [];
  for (const event of events) {
    const userId = event.source.userId;

    if (event.type === 'message' && event.message.type === 'text') {
      const text = event.message.text.trim();

      if (text.toLowerCase() === 'myid') {
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'text',
            text: `LINE User ID ของคุณคือ:\n${userId}`
          }]
        });
        continue;
      }

      if (['เช็กห้อง', 'เช็คห้อง', 'ตารางห้อง', 'ดูห้อง', 'มีห้องว่างไหม'].some(kw => text.includes(kw))) {
        const flex = await getTodayScheduleFlex();
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'flex', altText: 'ตารางการจองห้องประชุมวันนี้', contents: flex }]
        });
      } else if (['ยกเลิก', 'ยกเลิกห้อง', 'ยกเลิกการจอง'].some(kw => text.includes(kw))) {
        const flex = await getMyBookingsFlex(userId);
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'flex', altText: 'รายการจองของคุณ', contents: flex }]
        });
      } else if (['จัดการห้อง', 'ตารางทั้งหมด', 'admin', 'ดูคิวทั้งหมด'].some(kw => text.toLowerCase().includes(kw))) {
        if (!ADMIN_IDS.includes(userId)) {
          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{
              type: 'text',
              text: '⚠️ บัญชีนี้ไม่มีสิทธิ์เข้าถึงเมนูผู้ดูแลระบบ (Admin) ครับ'
            }]
          });
        } else {
          const flex = await getAdminAllBookingsFlex();
          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'flex', altText: 'รายการจองทั้งหมด (Admin)', contents: flex }]
          });
        }
      }
    }

    if (event.type === 'postback') {
      const params = new URLSearchParams(event.postback.data);
      const action = params.get('action');
      const bookingId = params.get('booking_id');

      // ยูสเซอร์กดยกเลิกของตัวเอง
      if (action === 'cancel') {
        let cancellerName = 'เจ้าของคิว';
        try {
          const profile = await lineClient.getProfile(userId);
          cancellerName = profile.displayName;
        } catch (e) {}

        const updateResult = await pool.query(
          `UPDATE bookings 
           SET status = 'cancelled', cancelled_by = $3
           WHERE id = $1 AND user_line_id = $2 AND status = 'confirmed' 
           RETURNING *;`,
          [bookingId, userId, cancellerName]
        );

        if (updateResult.rows.length > 0) {
          const item = updateResult.rows[0];
          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{
              type: 'text',
              text: `❌ ยกเลิกการจองสำเร็จ:\nห้อง: ${ROOM_NAMES[item.room_id]}\nหัวข้อ: ${item.title}`
            }]
          });
        } else {
          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '⚠️ ไม่พบรายการจอง หรือรายการนี้ถูกยกเลิกไปแล้วครับ' }]
          });
        }
      }

      // ADMIN กดยกเลิกผ่านแชต LINE
      if (action === 'admin_cancel') {
        if (!ADMIN_IDS.includes(userId)) {
          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '⚠️ คุณไม่มีสิทธิ์ยกเลิกรายการนี้ครับ' }]
          });
          continue;
        }

        let adminName = 'Admin (LINE)';
        try {
          const profile = await lineClient.getProfile(userId);
          adminName = `Admin: ${profile.displayName}`;
        } catch (e) {}

        const updateResult = await pool.query(
          `UPDATE bookings 
           SET status = 'cancelled', cancelled_by = $2 
           WHERE id = $1 AND status = 'confirmed' 
           RETURNING *;`,
          [bookingId, adminName]
        );

        if (updateResult.rows.length > 0) {
          const item = updateResult.rows[0];
          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{
              type: 'text',
              text: `🛡️ [Admin] ทำการยกเลิกเรียบร้อยแล้ว:\nผู้จอง: ${item.user_name}\nห้อง: ${ROOM_NAMES[item.room_id]}\nหัวข้อ: ${item.title}`
            }]
          });

          if (item.user_line_id && item.user_line_id !== userId) {
            lineClient.pushMessage({
              to: item.user_line_id,
              messages: [{
                type: 'text',
                text: `⚠️ แจ้งเตือน: รายการจอง "${item.title}" (${ROOM_NAMES[item.room_id]}) ของคุณถูกยกเลิกโดยผู้ดูแลระบบครับ`
              }]
            }).catch(console.error);
          }
        } else {
          await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '⚠️ ไม่พบรายการจอง หรือคิวนี้ถูกยกเลิกไปแล้ว' }]
          });
        }
      }
    }
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------
// 5. API จองห้อง
// ----------------------------------------------------
app.post('/api/bookings', async (req, res) => {
  const { user_line_id, user_name, room_id, title, start_time, end_time } = req.body;

  if (!user_line_id || !room_id || !start_time || !end_time) {
    return res.status(400).json({ error: 'กรอกข้อมูลไม่ครบถ้วน' });
  }

  const conflictingRooms = CONFLICT_RULES[room_id];
  if (!conflictingRooms) {
    return res.status(400).json({ error: 'ระบุห้องไม่ถูกต้อง' });
  }

  if (new Date(start_time) >= new Date(end_time)) {
    return res.status(400).json({ error: 'เวลาสิ้นสุดต้องมากกว่าเวลาเริ่มต้น' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE bookings IN SHARE ROW EXCLUSIVE MODE');

    const conflictQuery = `
      SELECT id, room_id, title, user_name, start_time, end_time 
      FROM bookings
      WHERE status = 'confirmed'
        AND room_id = ANY($1::text[])
        AND (start_time < $3 AND end_time > $2)
      ORDER BY start_time ASC
      LIMIT 1;
    `;
    const checkResult = await client.query(conflictQuery, [
      conflictingRooms,
      start_time,
      end_time
    ]);

    if (checkResult.rows.length > 0) {
      await client.query('ROLLBACK');
      const conflict = checkResult.rows[0];
      const sT = formatThaiTime(conflict.start_time);
      const eT = formatThaiTime(conflict.end_time);
      const rName = ROOM_NAMES[conflict.room_id] || conflict.room_id;

      return res.status(409).json({ 
        error: `ห้องไม่ว่างในช่วงเวลาดังกล่าว!\n📌 ชนกับ: ${rName}\n⏰ เวลา: ${sT} - ${eT} น.\n📝 หัวข้อ: ${conflict.title} (${conflict.user_name})` 
      });
    }

    const insertQuery = `
      INSERT INTO bookings (user_line_id, user_name, room_id, title, start_time, end_time, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'confirmed')
      RETURNING *;
    `;
    const inserted = await client.query(insertQuery, [
      user_line_id,
      user_name || 'ผู้ใช้ LINE',
      room_id,
      title || 'การประชุมทั่วไป',
      start_time,
      end_time
    ]);

    const booking = inserted.rows[0];
    await client.query('COMMIT');

    sendBookingConfirmation(user_line_id, booking).catch(err => 
      console.error('ส่ง LINE Notification ให้ผู้จองไม่สำเร็จ:', err.message)
    );

    notifyAdminsNewBooking(booking, user_line_id).catch(err =>
      console.error('ส่งแจ้งเตือน Admin ไม่สำเร็จ:', err.message)
    );

    res.status(201).json({ message: 'จองสำเร็จ', booking });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการบันทึกข้อมูล' });
  } finally {
    client.release();
  }
});

// ฟังก์ชันส่งการ์ดยืนยันให้ผู้จอง
async function sendBookingConfirmation(userId, booking) {
  const sTime = formatThaiTime(booking.start_time);
  const eTime = formatThaiTime(booking.end_time);
  const bDate = formatThaiDate(booking.start_time);

  const message = {
    type: 'flex',
    altText: `ยืนยันการจอง: ${ROOM_NAMES[booking.room_id]}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#06C755',
        contents: [
          { type: 'text', text: '✅ สำเร็จ: จองห้องประชุมแล้ว', color: '#ffffff', weight: 'bold', size: 'md' }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: booking.title, weight: 'bold', size: 'xl' },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              { type: 'text', text: `📍 ห้อง: ${ROOM_NAMES[booking.room_id]}`, size: 'sm', color: '#333333' },
              { type: 'text', text: `📅 วันที่: ${bDate}`, size: 'sm', color: '#555555' },
              { type: 'text', text: `⏰ เวลา: ${sTime} - ${eTime} น.`, size: 'sm', color: '#555555' },
              { type: 'text', text: `👤 ผู้จอง: ${booking.user_name}`, size: 'sm', color: '#777777' }
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            color: '#FF4B4B',
            height: 'sm',
            action: {
              type: 'postback',
              label: 'ยกเลิกการจองนี้',
              data: `action=cancel&booking_id=${booking.id}`
            }
          }
        ]
      }
    }
  };

  await lineClient.pushMessage({ to: userId, messages: [message] });
}

// ฟังก์ชันส่งแจ้งเตือนการจองใหม่ไปยัง Admin
async function notifyAdminsNewBooking(booking, bookerId) {
  if (!ADMIN_IDS.length) return;

  const sTime = formatThaiTime(booking.start_time);
  const eTime = formatThaiTime(booking.end_time);
  const bDate = formatThaiDate(booking.start_time);

  const adminMessage = {
    type: 'flex',
    altText: `📢 มีการจองห้องใหม่: ${booking.title}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0055FF',
        contents: [
          { type: 'text', text: '📢 มีการจองห้องประชุมใหม่', color: '#ffffff', weight: 'bold', size: 'md' }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: booking.title, weight: 'bold', size: 'lg' },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              { type: 'text', text: `👤 ผู้จอง: ${booking.user_name}`, size: 'sm', weight: 'bold', color: '#111111' },
              { type: 'text', text: `📍 ห้อง: ${ROOM_NAMES[booking.room_id]}`, size: 'sm', color: '#444444' },
              { type: 'text', text: `📅 วันที่: ${bDate}`, size: 'sm', color: '#666666' },
              { type: 'text', text: `⏰ เวลา: ${sTime} - ${eTime} น.`, size: 'sm', color: '#666666' }
            ]
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            color: '#FF4B4B',
            height: 'sm',
            action: {
              type: 'postback',
              label: 'ยกเลิกรายการนี้ (Admin)',
              data: `action=admin_cancel&booking_id=${booking.id}`
            }
          }
        ]
      }
    }
  };

  for (const adminId of ADMIN_IDS) {
    try {
      await lineClient.pushMessage({ to: adminId, messages: [adminMessage] });
    } catch (err) {
      console.error(`ไม่สามารถส่งข้อความหา Admin (${adminId}):`, err.message);
    }
  }
}

// ----------------------------------------------------
// 6. API สำหรับ Admin Dashboard (Web Admin)
// ----------------------------------------------------

// 6.1 ดึงรายการจองทั้งหมด (รวม cancelled_by)
app.get('/api/admin/bookings', async (req, res) => {
  const { key } = req.query;
  if (key !== ADMIN_DASHBOARD_PIN) {
    return res.status(401).json({ error: 'รหัสผ่าน Admin PIN ไม่ถูกต้อง' });
  }

  try {
    const result = await pool.query(`
      SELECT id, room_id, title, user_name, user_line_id, start_time, end_time, status, cancelled_by, created_at
      FROM bookings
      ORDER BY start_time DESC
      LIMIT 150;
    `);
    res.json({ bookings: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการดึงข้อมูล' });
  }
});

// 6.2 ยกเลิกการจองผ่านหน้าเว็บ Dashboard
app.post('/api/admin/bookings/:id/cancel', async (req, res) => {
  const { key } = req.body;
  const bookingId = req.params.id;

  if (key !== ADMIN_DASHBOARD_PIN) {
    return res.status(401).json({ error: 'รหัสผ่าน Admin PIN ไม่ถูกต้อง' });
  }

  try {
    const updateResult = await pool.query(
      `UPDATE bookings 
       SET status = 'cancelled', cancelled_by = 'Admin (Dashboard)' 
       WHERE id = $1 AND status = 'confirmed' 
       RETURNING *;`,
      [bookingId]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ error: 'ไม่พบรายการจอง หรือรายการนี้ถูกยกเลิกไปแล้ว' });
    }

    const item = updateResult.rows[0];

    if (item.user_line_id) {
      lineClient.pushMessage({
        to: item.user_line_id,
        messages: [{
          type: 'text',
          text: `⚠️ แจ้งเตือน: รายการจอง "${item.title}" (${ROOM_NAMES[item.room_id]}) ของคุณถูกยกเลิกโดยผู้ดูแลระบบผ่าน Dashboard ครับ`
        }]
      }).catch(console.error);
    }

    res.json({ message: 'ยกเลิกสำเร็จ', booking: item });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดในการยกเลิก' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
