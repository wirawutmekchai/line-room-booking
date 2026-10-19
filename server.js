require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const line = require('@line/bot-sdk');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ให้ Express ให้บริการไฟล์หน้าเว็บ Frontend จากโฟลเดอร์ public
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

// กฎการทับซ้อนของห้อง (Conflict Mapping)
const CONFLICT_RULES = {
  'R1': ['R1', 'R_ALL'],
  'R2': ['R2', 'R_ALL'],
  'R_ALL': ['R1', 'R2', 'R_ALL']
};

const ROOM_NAMES = {
  'R1': 'ห้องประชุม 1',
  'R2': 'ห้องประชุม 2',
  'R_ALL': 'ห้องประชุมใหญ่ (รวม 1+2)'
};

// 1. API: ดึงรายการจองตามวันที่ เพื่อนำไปแสดงในปฏิทิน
app.get('/api/bookings', async (req, res) => {
  const { date } = req.query; // รูปแบบ YYYY-MM-DD
  if (!date) return res.status(400).json({ error: 'กรุณาระบุวันที่' });

  try {
    const query = `
      SELECT id, room_id, title, user_name, start_time, end_time 
      FROM bookings 
      WHERE status = 'confirmed' 
        AND DATE(start_time) = $1
      ORDER BY start_time ASC;
    `;
    const result = await pool.query(query, [date]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ไม่สามารถดึงข้อมูลได้' });
  }
});

// 2. API: บันทึกการจองพร้อม Transaction ป้องกันชนกัน
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

    // ล็อกตารางแบบ SHARE ROW EXCLUSIVE ป้องกัน 2 คนกดพร้อมกันเสี้ยววินาที
    await client.query('LOCK TABLE bookings IN SHARE ROW EXCLUSIVE MODE');

    // ตรวจสอบว่ามีห้องที่ขัดแย้งถูกจองในช่วงเวลานี้ไปแล้วหรือไม่
    const conflictQuery = `
      SELECT id FROM bookings
      WHERE status = 'confirmed'
        AND room_id = ANY($1::text[])
        AND (start_time < $3 AND end_time > $2)
      LIMIT 1;
    `;
    const checkResult = await client.query(conflictQuery, [
      conflictingRooms,
      start_time,
      end_time
    ]);

    if (checkResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ 
        error: 'ห้องไม่ว่างในช่วงเวลาดังกล่าว (อาจมีผู้อื่นจองห้องนี้หรือห้องที่เชื่อมกันอยู่)' 
      });
    }

    // บันทึกข้อมูล
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

    // ส่ง LINE Flex Message แจ้งเตือนผู้จอง
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
  const sTime = new Date(booking.start_time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  const eTime = new Date(booking.end_time).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  const bDate = new Date(booking.start_time).toLocaleDateString('th-TH', { dateStyle: 'medium' });

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
      }
    }
  };

  await lineClient.pushMessage({ to: userId, messages: [message] });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});