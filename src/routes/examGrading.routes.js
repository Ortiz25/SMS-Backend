// routes/examGrading.js
import express from "express";
import pool from "../config/database.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);

/**
 * @route   GET /api/exams/types
 * @desc    Get all exam types
 * @access  Private
 */
router.get('/types',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const examTypes = await pool.query(
      `SELECT * FROM exam_types ORDER BY name`
    );
    
    res.json(examTypes.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// ... [other routes remain unchanged]

/**
 * @route   POST /api/exams/schedules/:scheduleId/results
 * @desc    Save/update exam results for students
 * @access  Private (Admin, Teacher, Staff only)
 */
router.post('/schedules/:scheduleId/results', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  // Use a connection from the pool directly instead of getClient
  let connection;
  
  try {
    // Begin transaction
    connection = await pool.connect();
    await connection.query('BEGIN');
    
    const scheduleId = req.params.scheduleId;
    const { results } = req.body;
    
    if (!Array.isArray(results)) {
      return res.status(400).json({ msg: 'Results must be an array' });
    }
    
    // Get the exam_schedule details with all necessary related information
    const scheduleResult = await connection.query(
      `SELECT es.*, 
              e.id AS examination_id,
              e.exam_type_id, 
              e.academic_session_id, 
              et.grading_system_id,
              c.id AS class_id,
              c.name AS class_name,
              s.id AS subject_id,
              s.name AS subject_name,
              s.code AS subject_code
       FROM exam_schedules es
       JOIN examinations e ON es.examination_id = e.id
       JOIN exam_types et ON e.exam_type_id = et.id
       JOIN classes c ON es.class_id = c.id
       JOIN subjects s ON es.subject_id = s.id
       WHERE es.id = $1`,
      [scheduleId]
    );
    
    if (scheduleResult.rows.length === 0) {
      await connection.query('ROLLBACK');
      return res.status(404).json({ msg: 'Exam schedule not found' });
    }
    
    const schedule = scheduleResult.rows[0];
    const { 
      grading_system_id, 
      total_marks, 
      passing_marks, 
      examination_id, 
      class_id, 
      academic_session_id 
    } = schedule;
    
    // Validate that the exam is not in 'completed' status
    if (schedule.status === 'completed') {
      await connection.query('ROLLBACK');
      return res.status(400).json({ 
        msg: 'Cannot modify results for a completed exam'
      });
    }
    
    // Get grading system for calculating grades and points
    const gradesResult = await connection.query(
      `SELECT * FROM grade_points 
       WHERE grading_system_id = $1
       ORDER BY lower_mark DESC`,
      [grading_system_id]
    );
    
    if (gradesResult.rows.length === 0) {
      await connection.query('ROLLBACK');
      return res.status(400).json({ msg: 'Grading system not configured properly' });
    }
    
    const gradePoints = gradesResult.rows;
    
    // Validate student IDs in one batch query
    const studentIds = results.map(r => r.student_id);
    
    // Check if students are in the proper class
    const studentsResult = await connection.query(
      `SELECT s.id, s.admission_number, s.first_name, s.last_name, s.current_class, s.stream
       FROM students s
       JOIN classes c ON s.current_class = c.level AND s.stream = c.stream
       WHERE s.id = ANY($1) 
       AND c.id = $2 
       AND s.status = 'active'`,
      [studentIds, class_id]
    );
    
    const validStudentIds = new Set(studentsResult.rows.map(r => r.id));
    const invalidStudents = results.filter(r => !validStudentIds.has(r.student_id));
    
    if (invalidStudents.length > 0) {
      await connection.query('ROLLBACK');
      return res.status(400).json({ 
        msg: 'Some students are not in this class or are inactive', 
        invalidStudents: invalidStudents.map(r => r.student_id)
      });
    }
    
    // Check if students are enrolled in this subject
    const enrollmentsResult = await connection.query(
      `SELECT student_id 
       FROM student_subjects
       WHERE student_id = ANY($1)
       AND subject_id = $2
       AND class_id = $3
       AND academic_session_id = $4
       AND status = 'active'`,
      [studentIds, schedule.subject_id, class_id, academic_session_id]
    );
    
    const enrolledStudentIds = new Set(enrollmentsResult.rows.map(r => r.student_id));
    const nonEnrolledStudents = results.filter(r => !enrolledStudentIds.has(r.student_id));
    
    // Just warn about non-enrolled students, don't block the operation
    if (nonEnrolledStudents.length > 0) {
      console.warn(`Some students are not enrolled in this subject: ${nonEnrolledStudents.map(r => r.student_id).join(', ')}`);
    }
    
    const savedResults = [];
    const updatedStudentIds = [];
    
    for (const result of results) {
      const { student_id, marks_obtained, is_absent } = result;
      
      // Validate marks
      if (!is_absent && marks_obtained !== null) {
        if (marks_obtained < 0 || marks_obtained > total_marks) {
          await connection.query('ROLLBACK');
          return res.status(400).json({ 
            msg: `Invalid marks for student ID ${student_id}. Must be between 0 and ${total_marks}.` 
          });
        }
      }
      
      // Calculate grade and points based on marks
      let grade = null;
      let points = null;
      
      if (!is_absent && marks_obtained !== null) {
        // Find the appropriate grade based on marks
        for (const gp of gradePoints) {
          if (marks_obtained >= gp.lower_mark && marks_obtained <= gp.upper_mark) {
            grade = gp.grade;
            points = gp.points;
            break;
          }
        }
      }
      
      // Check if result already exists
      const existingResult = await connection.query(
        `SELECT * FROM exam_results WHERE student_id = $1 AND exam_schedule_id = $2`,
        [student_id, scheduleId]
      );
      
      let savedResult;
      
      if (existingResult.rows.length > 0) {
        // Update existing result
        savedResult = await connection.query(
          `UPDATE exam_results
           SET marks_obtained = $1, grade = $2, points = $3, is_absent = $4, updated_at = NOW()
           WHERE student_id = $5 AND exam_schedule_id = $6
           RETURNING *`,
          [marks_obtained, grade, points, is_absent, student_id, scheduleId]
        );
      } else {
        // Insert new result
        savedResult = await connection.query(
          `INSERT INTO exam_results (student_id, exam_schedule_id, marks_obtained, grade, points, is_absent)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [student_id, scheduleId, marks_obtained, grade, points, is_absent]
        );
      }
      
      savedResults.push(savedResult.rows[0]);
      updatedStudentIds.push(student_id);
    }
    
    // Get updated student summaries (trigger-generated)
    const summaries = await connection.query(
      `SELECT srs.*, s.admission_number, s.first_name, s.last_name
       FROM student_result_summary srs
       JOIN students s ON srs.student_id = s.id
       WHERE srs.examination_id = $1 AND srs.student_id = ANY($2)
       ORDER BY srs.position_in_class`,
      [examination_id, updatedStudentIds]
    );
    
    // Update exam schedule status if all students have results
    const totalClassStudentsResult = await connection.query(
      `SELECT COUNT(*) FROM students
       WHERE current_class = $1 AND stream = $2 AND status = 'active'`,
      [schedule.level, schedule.stream]
    );
    
    const totalResultsResult = await connection.query(
      `SELECT COUNT(*) FROM exam_results er
       JOIN students s ON er.student_id = s.id
       WHERE er.exam_schedule_id = $1
       AND s.status = 'active'`,
      [scheduleId]
    );
    
    const totalClassStudents = parseInt(totalClassStudentsResult.rows[0].count);
    const totalResults = parseInt(totalResultsResult.rows[0].count);
    
    // If all students have results, mark the schedule as completed
    if (totalResults >= totalClassStudents) {
      await connection.query(
        `UPDATE exam_schedules
         SET status = 'completed', updated_at = NOW()
         WHERE id = $1`,
        [scheduleId]
      );
      
      // Check if all schedules for this exam are completed
      const remainingSchedulesResult = await connection.query(
        `SELECT COUNT(*) FROM exam_schedules
         WHERE examination_id = $1 AND status != 'completed' AND status != 'cancelled'`,
        [examination_id]
      );
      
      if (parseInt(remainingSchedulesResult.rows[0].count) === 0) {
        // Mark the entire examination as completed
        await connection.query(
          `UPDATE examinations
           SET status = 'completed', updated_at = NOW()
           WHERE id = $1`,
          [examination_id]
        );
      }
    }
    
    await connection.query('COMMIT');
    
    // Return results with summary data
    const response = {
      message: `Successfully saved ${savedResults.length} results`,
      scheduleDetails: {
        id: schedule.id,
        subject: schedule.subject_name,
        subjectCode: schedule.subject_code,
        className: schedule.class_name,
        totalMarks: schedule.total_marks,
        passingMarks: schedule.passing_marks,
        examDate: schedule.exam_date,
        status: schedule.status === 'completed' ? 'completed' : 'in_progress'
      },
      results: savedResults,
      summaries: summaries.rows
    };
    
    res.json(response);
  } catch (err) {
    if (connection) {
      await connection.query('ROLLBACK');
    }
    console.error('Error saving exam results:', err);
    res.status(500).json({
      msg: 'Server Error',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// ... [other routes remain unchanged]

export default router;