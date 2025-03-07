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

/**
 * @route   GET /api/exams
 * @desc    Get all examinations (can be filtered by academic session)
 * @access  Private
 */
router.get('/',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const { academic_session_id } = req.query;
    
    let query = `
      SELECT e.*, et.name as exam_type_name 
      FROM examinations e
      JOIN exam_types et ON e.exam_type_id = et.id
    `;
    
    const params = [];
    
    if (academic_session_id) {
      query += ` WHERE e.academic_session_id = $1`;
      params.push(academic_session_id);
    }
    
    query += ` ORDER BY e.start_date DESC`;
    
    const examinations = await pool.query(query, params);
    
    res.json(examinations.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route   POST /api/exams
 * @desc    Create a new examination
 * @access  Private
 */
router.post('/',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const { name, exam_type_id, academic_session_id, start_date, end_date, status } = req.body;
    
    const result = await pool.query(
      `INSERT INTO examinations 
        (name, exam_type_id, academic_session_id, start_date, end_date, status) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING *`,
      [name, exam_type_id, academic_session_id, start_date, end_date, status || 'scheduled']
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route   GET /api/exams/:id/schedules
 * @desc    Get exam schedules for a specific examination
 * @access  Private
 */
router.get('/:id/schedules',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const examId = req.params.id;
    
    const schedules = await pool.query(
      `SELECT es.*, s.name as subject_name, s.code as subject_code, 
              c.name as class_name, 
              t.first_name || ' ' || t.last_name as supervisor_name
       FROM exam_schedules es
       JOIN subjects s ON es.subject_id = s.id
       JOIN classes c ON es.class_id = c.id
       LEFT JOIN teachers t ON es.supervisor_id = t.id
       WHERE es.examination_id = $1
       ORDER BY es.exam_date, es.start_time`,
      [examId]
    );
    
    res.json(schedules.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route   POST /api/exams/:id/schedules
 * @desc    Create a new exam schedule
 * @access  Private
 */
router.post('/:id/schedules',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const examinationId = req.params.id;
    const { 
      subject_id, class_id, exam_date, start_time, end_time, 
      venue, supervisor_id, total_marks, passing_marks 
    } = req.body;
    
    const result = await pool.query(
      `INSERT INTO exam_schedules 
        (examination_id, subject_id, class_id, exam_date, start_time, end_time, 
         venue, supervisor_id, total_marks, passing_marks) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
       RETURNING *`,
      [examinationId, subject_id, class_id, exam_date, start_time, end_time, 
       venue, supervisor_id, total_marks || 100, passing_marks || (total_marks ? total_marks * 0.4 : 40)]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route   GET /api/exams/schedules/:scheduleId/results
 * @desc    Get results for a specific exam schedule
 * @access  Private
 */
router.get('/schedules/:scheduleId/results',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const scheduleId = req.params.scheduleId;
    
    const results = await pool.query(
      `SELECT er.*, s.first_name || ' ' || s.last_name as student_name,
              s.admission_number
       FROM exam_results er
       JOIN students s ON er.student_id = s.id
       WHERE er.exam_schedule_id = $1
       ORDER BY s.admission_number`,
      [scheduleId]
    );
    
    res.json(results.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route   POST /api/exams/schedules/:scheduleId/results
 * @desc    Save/update exam results for students
 * @access  Private
 */
router.post('/schedules/:scheduleId/results', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
    try {
      await pool.query('BEGIN');
      
      const scheduleId = req.params.scheduleId;
      const { results } = req.body;
      
      if (!Array.isArray(results)) {
        return res.status(400).json({ msg: 'Results must be an array' });
      }
      
      // Get the exam_schedule details for grading system reference
      const scheduleResult = await pool.query(
        `SELECT es.*, e.exam_type_id, e.academic_session_id, et.grading_system_id, es.total_marks
         FROM exam_schedules es
         JOIN examinations e ON es.examination_id = e.id
         JOIN exam_types et ON e.exam_type_id = et.id
         WHERE es.id = $1`,
        [scheduleId]
      );
      
      if (scheduleResult.rows.length === 0) {
        return res.status(404).json({ msg: 'Exam schedule not found' });
      }
      
      const { grading_system_id, total_marks, examination_id } = scheduleResult.rows[0];
      
      // Get grading system for calculating grades and points
      const gradesResult = await pool.query(
        `SELECT * FROM grade_points
         WHERE grading_system_id = $1
         ORDER BY lower_mark DESC`,
        [grading_system_id]
      );
      
      const gradePoints = gradesResult.rows;
      
      // Validate student IDs in one batch query
      const studentIds = results.map(r => r.student_id);
      const studentsResult = await pool.query(
        `SELECT id FROM students WHERE id = ANY($1)`,
        [studentIds]
      );
      
      const validStudentIds = new Set(studentsResult.rows.map(r => r.id));
      const invalidStudents = results.filter(r => !validStudentIds.has(r.student_id));
      
      if (invalidStudents.length > 0) {
        await pool.query('ROLLBACK');
        return res.status(400).json({ 
          msg: 'Some student IDs are invalid', 
          invalidStudents: invalidStudents.map(r => r.student_id)
        });
      }
      
      const savedResults = [];
      
      for (const result of results) {
        const { student_id, marks_obtained, is_absent } = result;
        
        // Validate marks
        if (!is_absent && (marks_obtained < 0 || marks_obtained > total_marks)) {
          await pool.query('ROLLBACK');
          return res.status(400).json({ 
            msg: `Invalid marks for student ID ${student_id}. Must be between 0 and ${total_marks}.` 
          });
        }
        
        // Calculate grade and points based on marks
        let grade = null;
        let points = null;
        
        if (!is_absent && marks_obtained !== null) {
          for (const gp of gradePoints) {
            if (marks_obtained >= gp.lower_mark && marks_obtained <= gp.upper_mark) {
              grade = gp.grade;
              points = gp.points;
              break;
            }
          }
        }
        
        // Check if result already exists
        const existingResult = await pool.query(
          `SELECT * FROM exam_results WHERE student_id = $1 AND exam_schedule_id = $2`,
          [student_id, scheduleId]
        );
        
        let savedResult;
        
        if (existingResult.rows.length > 0) {
          // Update existing result
          savedResult = await pool.query(
            `UPDATE exam_results
             SET marks_obtained = $1, grade = $2, points = $3, is_absent = $4, updated_at = NOW()
             WHERE student_id = $5 AND exam_schedule_id = $6
             RETURNING *`,
            [marks_obtained, grade, points, is_absent, student_id, scheduleId]
          );
        } else {
          // Insert new result
          savedResult = await pool.query(
            `INSERT INTO exam_results (student_id, exam_schedule_id, marks_obtained, grade, points, is_absent)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [student_id, scheduleId, marks_obtained, grade, points, is_absent]
          );
        }
        
        savedResults.push(savedResult.rows[0]);
      }
      
      // Verify result summaries were updated by the trigger
      const summaryCount = await pool.query(
        `SELECT COUNT(*) FROM student_result_summary 
         WHERE examination_id = $1 AND student_id = ANY($2)`,
        [examination_id, studentIds]
      );
      
      console.log(`Updated ${summaryCount.rows[0].count} student result summaries`);
      
      await pool.query('COMMIT');
      
      res.json(savedResults);
    } catch (err) {
      await pool.query('ROLLBACK');
      console.error(err.message);
      res.status(500).send('Server Error');
    }
  });

/**
 * @route   GET /api/exams/summary/:examId/:classId
 * @desc    Get exam summary for a specific exam and class
 * @access  Private
 */
router.get('/summary/:examId/:classId',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const { examId, classId } = req.params;
    
    const summary = await pool.query(
      `SELECT srs.*, s.first_name || ' ' || s.last_name as student_name,
              s.admission_number
       FROM student_result_summary srs
       JOIN students s ON srs.student_id = s.id
       WHERE srs.examination_id = $1 AND srs.class_id = $2
       ORDER BY srs.position_in_class`,
      [examId, classId]
    );
    
    res.json(summary.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route   GET /api/exams/student/:studentId
 * @desc    Get exam results for a specific student
 * @access  Private
 */
router.get('/student/:studentId',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const { studentId } = req.params;
    const { academic_session_id } = req.query;
    
    let query = `
      SELECT 
        srs.*,
        e.name as exam_name,
        e.start_date,
        e.end_date,
        et.name as exam_type_name,
        c.name as class_name,
        ac.year,
        ac.term
      FROM student_result_summary srs
      JOIN examinations e ON srs.examination_id = e.id
      JOIN exam_types et ON e.exam_type_id = et.id
      JOIN classes c ON srs.class_id = c.id
      JOIN academic_sessions ac ON e.academic_session_id = ac.id
      WHERE srs.student_id = $1
    `;
    
    const params = [studentId];
    
    if (academic_session_id) {
      query += ` AND e.academic_session_id = $2`;
      params.push(academic_session_id);
    }
    
    query += ` ORDER BY e.start_date DESC`;
    
    const results = await pool.query(query, params);
    
    // For each exam, get the subject results
    const fullResults = await Promise.all(
      results.rows.map(async (result) => {
        const subjectResults = await pool.query(
          `SELECT er.*, es.subject_id, s.name as subject_name, s.code as subject_code
           FROM exam_results er
           JOIN exam_schedules es ON er.exam_schedule_id = es.id
           JOIN subjects s ON es.subject_id = s.id
           WHERE er.student_id = $1 AND es.examination_id = $2
           ORDER BY s.name`,
          [studentId, result.examination_id]
        );
        
        return {
          ...result,
          subjectResults: subjectResults.rows
        };
      })
    );
    
    res.json(fullResults);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route   GET /api/exams/class-performance/:classId
 * @desc    Get class performance analytics
 * @access  Private
 */
router.get('/class-performance/:classId',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const { classId } = req.params;
    const { academic_session_id } = req.query;
    
    let query = `
      SELECT 
        e.id as examination_id,
        e.name as exam_name,
        AVG(srs.average_marks) as class_average,
        MAX(srs.average_marks) as highest_average,
        MIN(srs.average_marks) as lowest_average,
        COUNT(CASE WHEN srs.average_marks >= 70 THEN 1 END) as above_70_percent,
        COUNT(CASE WHEN srs.average_marks >= 50 AND srs.average_marks < 70 THEN 1 END) as between_50_70_percent,
        COUNT(CASE WHEN srs.average_marks < 50 THEN 1 END) as below_50_percent,
        COUNT(srs.id) as total_students
      FROM student_result_summary srs
      JOIN examinations e ON srs.examination_id = e.id
      WHERE srs.class_id = $1
    `;
    
    const params = [classId];
    
    if (academic_session_id) {
      query += ` AND e.academic_session_id = $2`;
      params.push(academic_session_id);
    }
    
    query += ` GROUP BY e.id, e.name ORDER BY e.start_date DESC`;
    
    const performance = await pool.query(query, params);
    
    res.json(performance.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route   GET /api/exams/subject-performance/:classId
 * @desc    Get subject performance analytics for a class
 * @access  Private
 */
router.get('/subject-performance/:classId',authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const { classId } = req.params;
    const { examination_id } = req.query;
    
    if (!examination_id) {
      return res.status(400).json({ msg: 'Examination ID is required' });
    }
    
    const performance = await pool.query(
      `SELECT 
        s.id as subject_id,
        s.name as subject_name,
        s.code as subject_code,
        AVG(er.marks_obtained) as average_marks,
        MAX(er.marks_obtained) as highest_marks,
        MIN(er.marks_obtained) as lowest_marks,
        COUNT(CASE WHEN er.marks_obtained >= es.passing_marks THEN 1 END) as passed_count,
        COUNT(CASE WHEN er.marks_obtained < es.passing_marks THEN 1 END) as failed_count,
        ROUND(COUNT(CASE WHEN er.marks_obtained >= es.passing_marks THEN 1 END) * 100.0 / COUNT(er.id), 2) as pass_percentage,
        COUNT(er.id) as total_students
      FROM exam_results er
      JOIN exam_schedules es ON er.exam_schedule_id = es.id
      JOIN subjects s ON es.subject_id = s.id
      WHERE es.class_id = $1 AND es.examination_id = $2 AND er.is_absent = false
      GROUP BY s.id, s.name, s.code
      ORDER BY s.name`,
      [classId, examination_id]
    );
    
    res.json(performance.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

export default router