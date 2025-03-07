import express from 'express';
import pool from '../config/database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);





// Get all rooms
router.get('/',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
    try {
      const { category_id, is_lab } = req.query;
      
      let query = `
        SELECT r.id, r.room_number, r.name, r.capacity, r.building, r.floor, 
               r.is_lab, c.name as category
        FROM rooms r
        JOIN room_categories c ON r.category_id = c.id
        WHERE r.is_available = true
      `;
      
      const queryParams = [];
      
      // Add filters if provided
      if (category_id) {
        queryParams.push(category_id);
        query += ` AND r.category_id = $${queryParams.length}`;
      }
      
      if (is_lab !== undefined) {
        queryParams.push(is_lab === 'true');
        query += ` AND r.is_lab = $${queryParams.length}`;
      }
      
      query += ` ORDER BY r.room_number`;
      
      const result = await pool.query(query, queryParams);
      res.json(result.rows);
    } catch (error) {
      console.error('Error fetching rooms:', error);
      res.status(500).json({ message: 'Server error' });
    }
  });
  
  // Get room by ID
  router.get('/:id',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
    try {
      const { id } = req.params;
      
      const query = `
        SELECT r.id, r.room_number, r.name, r.capacity, r.building, r.floor, 
               r.is_lab, r.notes, c.name as category
        FROM rooms r
        JOIN room_categories c ON r.category_id = c.id
        WHERE r.id = $1
      `;
      
      const result = await pool.query(query, [id]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ message: 'Room not found' });
      }
      
      res.json(result.rows[0]);
    } catch (error) {
      console.error('Error fetching room:', error);
      res.status(500).json({ message: 'Server error' });
    }
  });
  
  // Check room availability
  router.post('/check-availability',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
    try {
      const { room_number, day_of_week, start_time, end_time, academic_session_id } = req.body;
      
      if (!room_number || !day_of_week || !start_time || !end_time || !academic_session_id) {
        return res.status(400).json({
          message: 'Missing required fields',
          required: ['room_number', 'day_of_week', 'start_time', 'end_time', 'academic_session_id']
        });
      }
      
      const query = `
        SELECT t.id, c.level, c.stream, s.name as subject_name, 
               to_char(t.start_time, 'HH24:MI') as start_time,
               to_char(t.end_time, 'HH24:MI') as end_time,
               tea.first_name || ' ' || tea.last_name as teacher_name
        FROM timetable t
        JOIN classes c ON t.class_id = c.id
        JOIN subjects s ON t.subject_id = s.id
        JOIN teachers tea ON t.teacher_id = tea.id
        WHERE t.room_number = $1
          AND t.day_of_week = $2
          AND t.academic_session_id = $3
          AND (t.start_time, t.end_time) OVERLAPS ($4::time, $5::time)
      `;
      
      const result = await pool.query(query, [
        room_number, day_of_week, academic_session_id, start_time, end_time
      ]);
      
      if (result.rows.length === 0) {
        return res.json({ 
          available: true,
          message: 'Room is available at the requested time'
        });
      }
      
      res.json({
        available: false,
        conflicts: result.rows,
        message: `Room is already booked at the requested time`
      });
    } catch (error) {
      console.error('Error checking room availability:', error);
      res.status(500).json({ message: 'Server error' });
    }
  });

  export default router