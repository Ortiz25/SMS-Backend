import express from "express";
import pool from "../config/database.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);


/**
 * @route GET /api/academic-sessions
 * @desc Get all academic sessions
 * @access Private (requires auth middleware)
 */
router.get('/', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT id, year, term, start_date, end_date, is_current, status
        FROM academic_sessions
        ORDER BY year DESC, term ASC
      `);
      
      res.json({ sessions: result.rows });
    } catch (err) {
      console.error('Error fetching academic sessions:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });
  
  /**
   * @route GET /api/academic-sessions/current
   * @desc Get the current academic session
   * @access Private (requires auth middleware)
   */
  router.get('/current', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT id, year, term, start_date, end_date
        FROM academic_sessions
        WHERE is_current = true
        LIMIT 1
      `);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ message: 'No current academic session found' });
      }
      
      res.json({ session: result.rows[0] });
    } catch (err) {
      console.error('Error fetching current academic session:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });
  
 
  /**
   * @route GET /api/attendance/summary/weekly
   * @desc Get weekly attendance summary for a specific academic session
   * @access Private (requires auth middleware)
   */
  router.get('/summary/weekly', async (req, res) => {
    const { academic_session_id } = req.query;
    
    if (!academic_session_id) {
      return res.status(400).json({ message: 'Academic session ID is required' });
    }
    
    try {
      // Get academic session info
      const sessionResult = await pool.query(`
        SELECT start_date, end_date, year, term
        FROM academic_sessions
        WHERE id = $1
      `, [academic_session_id]);
      
      if (sessionResult.rows.length === 0) {
        return res.status(404).json({ message: 'Academic session not found' });
      }
      
      const { start_date, end_date } = sessionResult.rows[0];
      
      // Generate weekly data for the academic session
      const weeklyDataQuery = `
        WITH date_range AS (
          SELECT 
            generate_series(
              $1::date, 
              $2::date, 
              '1 week'::interval
            )::date AS week_start_date
        ),
        weeks AS (
          SELECT 
            EXTRACT(WEEK FROM week_start_date)::int AS week_number,
            week_start_date,
            (week_start_date + interval '6 days')::date AS week_end_date
          FROM date_range
        ),
        active_students AS (
          SELECT COUNT(id) AS total_students
          FROM students
          WHERE status = 'active'
        ),
        weekly_attendance AS (
          SELECT 
            EXTRACT(WEEK FROM a.date)::int AS week_number,
            COUNT(CASE WHEN a.status = 'present' THEN 1 END) AS present_count,
            COUNT(CASE WHEN a.status = 'absent' THEN 1 END) AS absent_count,
            COUNT(CASE WHEN a.status = 'late' THEN 1 END) AS late_count,
            COUNT(CASE WHEN a.status = 'on-leave' THEN 1 END) AS leave_count,
            COUNT(*) AS total_records
          FROM attendance a
          JOIN classes c ON a.class_id = c.id
          WHERE a.date BETWEEN $1 AND $2
          AND c.academic_session_id = $3
          GROUP BY week_number
        )
        SELECT 
          w.week_number,
          w.week_start_date,
          w.week_end_date,
          COALESCE(wa.present_count, 0) AS present_count,
          COALESCE(wa.absent_count, 0) AS absent_count,
          COALESCE(wa.late_count, 0) AS late_count,
          COALESCE(wa.leave_count, 0) AS leave_count,
          COALESCE((wa.present_count * 100.0 / NULLIF(wa.total_records, 0))::numeric(5,2), 0) AS attendance_rate,
          (SELECT total_students FROM active_students) AS total_students
        FROM weeks w
        LEFT JOIN weekly_attendance wa ON w.week_number = wa.week_number
        ORDER BY w.week_number
      `;
      
      const weeklyData = await pool.query(weeklyDataQuery, [start_date, end_date, academic_session_id]);
      
      res.json({ 
        academicSession: sessionResult.rows[0],
        weeklyData: weeklyData.rows 
      });
    } catch (err) {
      console.error('Error fetching weekly attendance summary:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });
  
  /**
   * @route GET /api/attendance/summary/class
   * @desc Get attendance summary by class for a specific academic session
   * @access Private (requires auth middleware)
   */
  router.get('/summary/class', async (req, res) => {
    const { academic_session_id } = req.query;
    
    if (!academic_session_id) {
      return res.status(400).json({ message: 'Academic session ID is required' });
    }
    
    try {
      const classSummaryQuery = `
        SELECT 
          c.id AS class_id,
          c.name AS class_name,
          c.level, 
          c.stream,
          COUNT(DISTINCT s.id) AS total_students,
          SUM(CASE WHEN as2.present_days > 0 THEN as2.present_days ELSE 0 END) AS present_days,
          SUM(CASE WHEN as2.absent_days > 0 THEN as2.absent_days ELSE 0 END) AS absent_days,
          SUM(CASE WHEN as2.late_days > 0 THEN as2.late_days ELSE 0 END) AS late_days,
          SUM(CASE WHEN as2.leave_days > 0 THEN as2.leave_days ELSE 0 END) AS leave_days,
          ROUND(AVG(CASE WHEN as2.attendance_percentage > 0 THEN as2.attendance_percentage ELSE NULL END)::numeric, 2) AS avg_attendance_percentage
        FROM 
          classes c
        JOIN 
          students s ON c.level = s.current_class AND c.stream = s.stream
        LEFT JOIN 
          attendance_summary as2 ON s.id = as2.student_id AND as2.academic_session_id = $1
        WHERE 
          c.academic_session_id = $1
          AND s.status = 'active'
        GROUP BY 
          c.id, c.name, c.level, c.stream
        ORDER BY 
          c.level, c.stream
      `;
      
      const classSummary = await pool.query(classSummaryQuery, [academic_session_id]);
      
      res.json({ classSummary: classSummary.rows });
    } catch (err) {
      console.error('Error fetching class attendance summary:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });
  
  /**
   * @route GET /api/attendance/student/:student_id
   * @desc Get attendance records for a specific student
   * @access Private (requires auth middleware)
   */
  router.get('/student/:student_id', async (req, res) => {
    const { student_id } = req.params;
    const { academic_session_id } = req.query;
    
    if (!academic_session_id) {
      return res.status(400).json({ message: 'Academic session ID is required' });
    }
    
    try {
      // Get student info
      const studentQuery = `
        SELECT s.id, s.first_name, s.last_name, s.admission_number, s.current_class, s.stream
        FROM students s
        WHERE s.id = $1
      `;
      
      const studentResult = await pool.query(studentQuery, [student_id]);
      
      if (studentResult.rows.length === 0) {
        return res.status(404).json({ message: 'Student not found' });
      }
      
      // Get attendance summary
      const summaryQuery = `
        SELECT 
          present_days, 
          absent_days, 
          late_days, 
          leave_days, 
          total_school_days, 
          attendance_percentage
        FROM attendance_summary
        WHERE student_id = $1 AND academic_session_id = $2
      `;
      
      const summaryResult = await pool.query(summaryQuery, [student_id, academic_session_id]);
      
      // Get attendance records
      const recordsQuery = `
        SELECT 
          a.id,
          a.date,
          a.session_type,
          a.status,
          a.reason,
          u.username AS recorded_by_username
        FROM attendance a
        LEFT JOIN users u ON a.recorded_by = u.id
        JOIN classes c ON a.class_id = c.id
        WHERE a.student_id = $1
        AND c.academic_session_id = $2
        ORDER BY a.date DESC, a.session_type
      `;
      
      const recordsResult = await pool.query(recordsQuery, [student_id, academic_session_id]);
      
      res.json({ 
        student: studentResult.rows[0],
        summary: summaryResult.rows[0] || {
          present_days: 0,
          absent_days: 0,
          late_days: 0,
          leave_days: 0,
          total_school_days: 0,
          attendance_percentage: 0
        },
        records: recordsResult.rows
      });
    } catch (err) {
      console.error('Error fetching student attendance:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });
  
  /**
   * @route POST /api/attendance
   * @desc Record attendance for a student
   * @access Private (requires auth middleware)
   */
  router.post('/', async (req, res) => {
    const { student_id, class_id, date, session_type, status, reason } = req.body;
    
    // Assume user_id comes from auth middleware
    const recorded_by = req.user.id;
    
    // Validate required fields
    if (!student_id || !class_id || !date || !session_type || !status) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    
    try {
      // Begin transaction
      await pool.query('BEGIN');
      
      // Check if attendance record already exists
      const existingRecord = await pool.query(
        'SELECT id FROM attendance WHERE student_id = $1 AND date = $2 AND session_type = $3',
        [student_id, date, session_type]
      );
      
      let result;
      
      if (existingRecord.rows.length > 0) {
        // Update existing record
        result = await pool.query(`
          UPDATE attendance
          SET status = $1, reason = $2, recorded_by = $3, updated_at = NOW()
          WHERE student_id = $4 AND date = $5 AND session_type = $6
          RETURNING id
        `, [status, reason, recorded_by, student_id, date, session_type]);
      } else {
        // Insert new record
        result = await pool.query(`
          INSERT INTO attendance 
            (student_id, class_id, date, session_type, status, reason, recorded_by)
          VALUES 
            ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id
        `, [student_id, class_id, date, session_type, status, reason, recorded_by]);
      }
      
      // Commit transaction
      await pool.query('COMMIT');
      
      res.status(201).json({ id: result.rows[0].id, message: 'Attendance recorded successfully' });
    } catch (err) {
      // Rollback in case of error
      await pool.query('ROLLBACK');
      console.error('Error recording attendance:', err);
      res.status(500).json({ message: 'Server error' });
    }
  });


  export default router