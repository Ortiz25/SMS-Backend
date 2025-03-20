import express from "express";
import { validate } from "../middleware/validate.js";
import { body } from "express-validator";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";
import { createAttendanceModel } from "../models/attendanceModel.js";
import pool from "../config/database.js";

const router = express.Router();
const attendanceModel = createAttendanceModel();

const attendanceValidation = [
  body("student_id").isInt(),
  body("class_id").isInt(),
  body("date").isDate(),
  body("session_type").isIn(["morning", "afternoon", "evening"]),
  body("status").isIn(["present", "absent", "late", "half-day", "on-leave"]),
];

router.use(authenticateToken);

router.get('/', authorizeRoles("admin", "teacher"), async (req, res) => {
  try {
    // Extract filter parameters from query string
    const { class: classLevel, status, date, startDate, endDate } = req.query;
    
    // Start building the SQL query with basic joins
    let query = `
      SELECT a.id, a.student_id, a.date, a.session_type, a.status, a.reason, 
             s.first_name, s.last_name, s.admission_number as admission_number, 
             c.level as class_level, c.stream
      FROM attendance a
      JOIN students s ON a.student_id = s.id
      JOIN classes c ON a.class_id = c.id
      WHERE 1=1
    `;
    
    const queryParams = [];
    
    // Add filters to the query based on provided parameters
    if (classLevel) {
      query += ` AND c.level = $${queryParams.length + 1}`;
      queryParams.push(classLevel);
    }
    
    if (status && status !== 'all') {
      query += ` AND a.status = $${queryParams.length + 1}`;
      queryParams.push(status);
    }
    
    // Handle date filtering
    if (date) {
      // Single day filter
      query += ` AND a.date = $${queryParams.length + 1}`;
      queryParams.push(date);
    } else if (startDate && endDate) {
      // Date range filter
      query += ` AND a.date >= $${queryParams.length + 1} AND a.date <= $${queryParams.length + 2}`;
      queryParams.push(startDate, endDate);
    }
    
    // Add order by clause
    query += ` ORDER BY a.date DESC, s.first_name ASC`;
    
    // Execute the query
    const { rows } = await pool.query(query, queryParams);
    
    // Return the attendance data
    return res.status(200).json({
      success: true,
      data: rows,
      message: 'Attendance records retrieved successfully'
    });
    
  } catch (error) {
    console.error('Error fetching attendance records:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch attendance records'
    });
  }
});

// Mark attendance
router.post(
  "/",
  authorizeRoles("admin", "teacher"),
  validate(attendanceValidation),
  async (req, res, next) => {
    try {
      const result = await attendanceModel.create({
        ...req.body,
        recorded_by: req.user.id,
      });
      res.status(201).json(result.rows[0]);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/class/:classId",
  authorizeRoles("admin", "teacher", "staff"),
  async (req, res, next) => {
    try {
      const { classId } = req.params;
      const { date, academicSessionId } = req.query;
      console.log(classId, date, academicSessionId);

      // Validate required parameters
      if (!classId || !date) {
        return res.status(400).json({
          success: false,
          error: "Class ID and date are required",
        });
      }

      // Get current academic session if not specified
      let currentSessionId = academicSessionId;
      if (!currentSessionId) {
        const sessionResult = await pool.query(
          "SELECT id FROM academic_sessions WHERE is_current = true LIMIT 1"
        );
        if (sessionResult.rows.length > 0) {
          currentSessionId = sessionResult.rows[0].id;
        }
      }
      
      // Fetch attendance records
      let query = `
        SELECT
            a.id,
            a.student_id,
            s.admission_number,
            s.first_name || ' ' || s.last_name AS student_name,
            a.date,
            a.session_type,
            a.status,
            a.reason,
            u.username AS recorded_by_username,
            a.created_at
        FROM
            attendance a
        JOIN
            students s ON a.student_id = s.id
        JOIN
            users u ON a.recorded_by = u.id
        WHERE
            a.class_id = $1
            AND a.date = $2
      `;
      
      const queryParams = [classId, date];
      
      // Order by student name
      query += ` ORDER BY student_name`;
      
      const result = await pool.query(query, queryParams);
      
      res.json({
        success: true,
        count: result.rows.length,
        data: result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);

// Insert or update attendance records (bulk)
router.post(
  "/bulk",
  authorizeRoles("admin", "teacher"),
  async (req, res, next) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { attendanceRecords } = req.body;
      
      if (
        !attendanceRecords ||
        !Array.isArray(attendanceRecords) ||
        attendanceRecords.length === 0
      ) {
        return res.status(400).json({
          success: false,
          error: "Valid attendance records are required",
        });
      }
      
      const results = [];
      
      // Process each attendance record
      for (const record of attendanceRecords) {
        // Check if record already exists
        const checkQuery = `
          SELECT id FROM attendance
          WHERE student_id = $1
          AND date = $2
          AND session_type = $3
        `;
        
        const checkResult = await client.query(checkQuery, [
          record.student_id,
          record.date,
          record.session_type,
        ]);
        
        let result;
        
        if (checkResult.rows.length > 0) {
          // Update existing record
          const updateQuery = `
            UPDATE attendance
            SET
              class_id = $1,
              status = $2,
              reason = $3,
              recorded_by = $4,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = $5
            RETURNING *
          `;
          
          result = await client.query(updateQuery, [
            record.class_id,
            record.status,
            record.reason || null,
            req.user.id,
            checkResult.rows[0].id,
          ]);
        } else {
          // Insert new record
          const insertQuery = `
            INSERT INTO attendance (
              student_id,
              class_id,
              date,
              session_type,
              status,
              reason,
              recorded_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
          `;
          
          result = await client.query(insertQuery, [
            record.student_id,
            record.class_id,
            record.date,
            record.session_type,
            record.status,
            record.reason || null,
            req.user.id,
          ]);
        }
        
        results.push(result.rows[0]);
      }
      
      await client.query("COMMIT");
      
      res.status(201).json({
        success: true,
        count: results.length,
        data: results,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      next(error);
    } finally {
      client.release();
    }
  }
);

// Get class attendance
router.get(
  "/class/:classId",
  authorizeRoles("admin", "teacher"),
  async (req, res, next) => {
    try {
      const { date } = req.query;
      const result = await attendanceModel.getClassAttendance(
        req.params.classId,
        new Date(date)
      );
      res.json(result.rows);
    } catch (error) {
      next(error);
    }
  }
);

// Update attendance
router.put(
  "/:id",
  authorizeRoles("admin", "teacher"),
  validate(attendanceValidation),
  async (req, res, next) => {
    try {
      const result = await attendanceModel.update(req.params.id, {
        ...req.body,
        modified_by: req.user.id,
        modified_at: new Date(),
      });
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Attendance record not found" });
      }
      res.json(result.rows[0]);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/student/:id",
  authorizeRoles("admin", "teacher", "parent", "staff"),
  async (req, res, next) => {
    try {
      const studentId = req.params.id;
      console.log("Fetching attendance for student ID:", studentId);
      
      const academicSessionId =
        req.query.academicSessionId ||
        (
          await pool.query(
            "SELECT id FROM academic_sessions WHERE is_current = true LIMIT 1"
          )
        ).rows[0]?.id;
        
      if (!academicSessionId) {
        return res.status(404).json({
          success: false,
          error: "No active academic session found",
        });
      }
      console.log(academicSessionId)
      
      // 1. Fetch attendance summary from attendance_summary table
      const summaryQuery = `
            SELECT
                total_school_days as total_days,
                present_days,
                absent_days,
                late_days,
                leave_days,
                attendance_percentage as present_percentage,
                ROUND((absent_days * 100.0 / NULLIF(total_school_days, 0))::numeric, 1) as absent_percentage
            FROM attendance_summary
            WHERE student_id = $1
            AND academic_session_id = $2
        `;
      
      // 2. Fetch recent attendance (last 10 records)
      const recentQuery = `
            SELECT
                TO_CHAR(date, 'YYYY-MM-DD') as date,
                INITCAP(status) as status,
                session_type,
                reason as remarks
            FROM attendance
            WHERE student_id = $1
            AND date >= (
                SELECT start_date 
                FROM academic_sessions 
                WHERE id = $2
            )
            AND date <= (
                SELECT end_date 
                FROM academic_sessions 
                WHERE id = $2
            )
            ORDER BY date DESC, session_type
            LIMIT 10
        `;
      
      // 3. Fetch monthly attendance data for a chart
      const monthlyQuery = `
            SELECT
                TO_CHAR(date, 'YYYY-MM') as month,
                COUNT(*) as total_days,
                COUNT(CASE WHEN status = 'present' THEN 1 END) as present_days,
                COUNT(CASE WHEN status = 'absent' THEN 1 END) as absent_days,
                COUNT(CASE WHEN status = 'late' THEN 1 END) as late_days,
                COUNT(CASE WHEN status = 'on-leave' THEN 1 END) as leave_days
            FROM attendance
            WHERE student_id = $1
            AND date >= (
                SELECT start_date 
                FROM academic_sessions 
                WHERE id = $2
            )
            AND date <= (
                SELECT end_date 
                FROM academic_sessions 
                WHERE id = $2
            )
            GROUP BY TO_CHAR(date, 'YYYY-MM')
            ORDER BY month
        `;
      
      // Execute all queries in parallel
      const [summaryResult, recentResult, monthlyResult] = await Promise.all([
        pool.query(summaryQuery, [studentId, academicSessionId]),
        pool.query(recentQuery, [studentId, academicSessionId]),
        pool.query(monthlyQuery, [studentId, academicSessionId]),
      ]);

      //console.log(summaryResult, recentResult, monthlyResult)
      
      // Format the monthly data for charts
      const monthlyData = monthlyResult.rows.map(row => {
        const [year, month] = row.month.split('-');
        const monthName = new Date(year, month - 1, 1).toLocaleString('default', { month: 'short' });
        
        return {
          month: monthName,
          year: year,
          total_days: row.total_days,
          present_days: row.present_days,
          absent_days: row.absent_days,
          late_days: row.late_days,
          leave_days: row.leave_days,
          present_percentage: row.total_days > 0 
            ? Math.round((row.present_days * 100.0 / row.total_days) * 10) / 10 
            : 0
        };
      });
      
      // Format the response
      res.json({
        success: true,
        data: {
          summary: summaryResult.rows[0] || {
            total_days: 0,
            present_days: 0,
            absent_days: 0,
            late_days: 0,
            leave_days: 0,
            present_percentage: 0,
            absent_percentage: 0,
          },
          recent: recentResult.rows,
          monthly: monthlyData
        },
      });
    } catch (error) {
      console.error("Error fetching attendance:", error);
      next(error);
    }
  }
);

export default router;
