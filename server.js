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

const CONFLICT_RULES = {
  'R1': ['R1', 'R_ALL'],
  'R2': ['R2', 'R_ALL'],
  'R_ALL': ['R1', 'R2', 'R_ALL']
};

const ROOM_NAMES = {
  'R1': 'ห้อง 1 (ห้องเล็ก)',
  'R2': 'ห้อง 2 (ห้องเล็ก)',
  'R_ALL': 'ห้องประชุมใหญ่ (รวม 1+2)'
};

// ----------------------------------------------------
// 1. ฟังก์ชัน Flex Message: ดูตารางห้องวันนี้
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
    const sTime = new Date(b.start_time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
    const eTime = new Date(b.end_time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });

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
// 2. ฟังก์ชัน Flex Message: ดูรายการจองของตนเองเพื่อยกเลิก
// ----------------------------------------------------
async function getMyBookingsFlex(userId) {
  const query = `
    SELECT id, room_id, title, start_time, end_time
    FROM bookings
    WHERE status = 'confirmed'
      AND user_line_id = $1
      AND end_time >= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')
    ORDER BY start_time ASC
    LIMIT 5;
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
    const sTime = new Date(b.start_time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
    const eTime = new Date(b.end_time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
    const bDate = new Date(b.start_time).toLocaleDateString('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });

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
// 3. Webhook จัดการ Event ของ LINE
// ----------------------------------------------------
app.post('/webhook', express.json(), async (req, res) => {
  res.status(200).send('OK');

  const events = req.body.events || [];
  for (const event of events) {
    // ผู้ใช้ส่งข้อความ
    if (event.type === 'message' && event.message.type === 'text') {
      const text = event.message.text.trim();

      if (['เช็กห้อง', 'เช็คห้อง', 'ตารางห้อง', 'ดูห้อง', 'มีห้องว่างไหม'].some(kw => text.includes(kw))) {
        const flex = await getTodayScheduleFlex();
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'flex', altText: 'ตารางการจองห้องประชุมวันนี้', contents: flex }]
        });
      } else if (['ยกเลิก', 'ยกเลิกห้อง', 'ยกเลิกการจอง'].some(kw => text.includes(kw))) {
        const flex = await getMyBookingsFlex(event.source.userId);
        await lineClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: 'flex', altText: 'รายการจองของคุณ', contents: flex }]
        });
      }
    }

    // ผู้ใช้กดยกเลิกจากปุ่ม Postback Action
    if (event.type === 'postback') {
      const params = new URLSearchParams(event.postback.data);
      if (params.get('action') === 'cancel') {
        const bookingId = params.get('booking_id');
        const userId = event.source.userId;

        const updateResult = await pool.query(
          `UPDATE bookings SET status = 'cancelled' 
           WHERE id = $1 AND user_line_id = $2 AND status = 'confirmed' 
           RETURNING *;`,
          [bookingId, userId]
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
            messages: [{
              type: 'text',
              text: '⚠️ ไม่พบรายการจอง หรือรายการนี้ถูกยกเลิกไปแล้วครับ'
            }]
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
// 4. API จองห้อง (พร้อมระบุว่าชนกับห้องไหน เวลาใด)
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

    // ดึงข้อมูลรายการที่มีเวลาชนกันออกมาแสดง
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
      const sT = new Date(conflict.start_time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
      const eT = new Date(conflict.end_time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
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
      console.error('ส่ง LINE Notification ไม่สำเร็จ:', err.message)
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

async function sendBookingConfirmation(userId, booking) {
  const sTime = new Date(booking.start_time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
  const eTime = new Date(booking.end_time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
  const bDate = new Date(booking.start_time).toLocaleDateString('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});
