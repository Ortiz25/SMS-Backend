import express from "express";
import pool from "../config/database.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);
/**
 * @route   GET /api/analytics/class-summary/:classId
 * @desc    Get performance summary for a class
 * @access  Private
 */
router.get('/class-summary/:classId', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const { classId } = req.params;
    const { academic_session_id } = req.query;
    
    if (!academic_session_id) {
      return res.status(400).json({ msg: 'Academic session ID is required' });
    }
    
    // Get class details
    const classDetails = await pool.query(
      `SELECT * FROM classes WHERE id = $1`,
      [classId]
    );
    
    if (classDetails.rows.length === 0) {
      return res.status(404).json({ msg: 'Class not found' });
    }
    
    // Get examinations in this academic session
    const exams = await pool.query(
      `SELECT e.*, et.name as exam_type_name
       FROM examinations e
       JOIN exam_types et ON e.exam_type_id = et.id
       WHERE e.academic_session_id = $1
       ORDER BY e.start_date`,
      [academic_session_id]
    );
    
    // Get performance data for each exam
    const examPerformance = await Promise.all(
      exams.rows.map(async (exam) => {
        const performance = await pool.query(
          `SELECT 
            COUNT(srs.id) as total_students,
            ROUND(AVG(srs.average_marks), 2) as average_score,
            MAX(srs.average_marks) as highest_score,
            MIN(srs.average_marks) as lowest_score,
            COUNT(CASE WHEN srs.average_marks >= 70 THEN 1 END) as a_grade_count,
            COUNT(CASE WHEN srs.average_marks >= 60 AND srs.average_marks < 70 THEN 1 END) as b_grade_count,
            COUNT(CASE WHEN srs.average_marks >= 50 AND srs.average_marks < 60 THEN 1 END) as c_grade_count,
            COUNT(CASE WHEN srs.average_marks >= 40 AND srs.average_marks < 50 THEN 1 END) as d_grade_count,
            COUNT(CASE WHEN srs.average_marks < 40 THEN 1 END) as fail_count
          FROM student_result_summary srs
          WHERE srs.class_id = $1 AND srs.examination_id = $2`,
          [classId, exam.id]
        );
        
        // Get top 5 students
        const topStudents = await pool.query(
          `SELECT 
            srs.student_id,
            s.first_name || ' ' || s.last_name as student_name,
            s.admission_number,
            srs.average_marks,
            srs.grade,
            srs.position_in_class
          FROM student_result_summary srs
          JOIN students s ON srs.student_id = s.id
          WHERE srs.class_id = $1 AND srs.examination_id = $2
          ORDER BY srs.average_marks DESC
          LIMIT 5`,
          [classId, exam.id]
        );
        
        return {
          exam: exam,
          performance: performance.rows[0],
          topStudents: topStudents.rows
        };
      })
    );
    
    // Get subject performance across all exams
    const subjectPerformance = await pool.query(
      `SELECT 
        s.id as subject_id,
        s.name as subject_name,
        s.code as subject_code,
        ROUND(AVG(er.marks_obtained), 2) as average_marks,
        COUNT(DISTINCT er.student_id) as total_students
      FROM exam_results er
      JOIN exam_schedules es ON er.exam_schedule_id = es.id
      JOIN subjects s ON es.subject_id = s.id
      JOIN examinations e ON es.examination_id = e.id
      WHERE es.class_id = $1 AND e.academic_session_id = $2 AND er.is_absent = false
      GROUP BY s.id, s.name, s.code
      ORDER BY average_marks DESC`,
      [classId, academic_session_id]
    );
    
    // Get trend data (average scores over time)
    const trendData = await pool.query(
      `SELECT 
        e.name as exam_name,
        e.start_date,
        ROUND(AVG(srs.average_marks), 2) as class_average
      FROM student_result_summary srs
      JOIN examinations e ON srs.examination_id = e.id
      WHERE srs.class_id = $1 AND e.academic_session_id = $2
      GROUP BY e.id, e.name, e.start_date
      ORDER BY e.start_date`,
      [classId, academic_session_id]
    );
    
    // Compile complete analytics
    const analytics = {
      classDetails: classDetails.rows[0],
      examPerformance,
      subjectPerformance: subjectPerformance.rows,
      trendData: trendData.rows
    };
    
    res.json(analytics);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route   GET /api/analytics/student-progress/:studentId
 * @desc    Get progress tracking for a specific student
 * @access  Private
 */
router.get('/student-progress/:studentId', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const { studentId } = req.params;
    const { academic_session_id } = req.query;
    
    // Get student details
    const studentDetails = await pool.query(
      `SELECT * FROM students WHERE id = $1`,
      [studentId]
    );
    
    if (studentDetails.rows.length === 0) {
      return res.status(404).json({ msg: 'Student not found' });
    }
    
    // Query parameters
    const params = [studentId];
    let sessionCondition = '';
    
    if (academic_session_id) {
      sessionCondition = 'AND e.academic_session_id = $2';
      params.push(academic_session_id);
    }
    
    // Get exam results over time
    const examResults = await pool.query(
      `SELECT 
        e.id as examination_id,
        e.name as exam_name,
        e.start_date,
        ac.year,
        ac.term,
        srs.average_marks,
        srs.grade,
        srs.position_in_class,
        srs.position_overall
      FROM student_result_summary srs
      JOIN examinations e ON srs.examination_id = e.id
      JOIN academic_sessions ac ON e.academic_session_id = ac.id
      WHERE srs.student_id = $1 ${sessionCondition}
      ORDER BY e.start_date`,
      params
    );
    
    // Get subject performance over time
    const subjectProgress = await pool.query(
      `SELECT 
        s.id as subject_id,
        s.name as subject_name,
        s.code as subject_code,
        e.id as examination_id,
        e.name as exam_name,
        e.start_date,
        er.marks_obtained,
        er.grade
      FROM exam_results er
      JOIN exam_schedules es ON er.exam_schedule_id = es.id
      JOIN subjects s ON es.subject_id = s.id
      JOIN examinations e ON es.examination_id = e.id
      WHERE er.student_id = $1 ${sessionCondition}
      ORDER BY s.name, e.start_date`,
      params
    );
    
    // Reorganize subject progress data by subject
    const subjectData = {};
    subjectProgress.rows.forEach(row => {
      if (!subjectData[row.subject_id]) {
        subjectData[row.subject_id] = {
          subject_id: row.subject_id,
          subject_name: row.subject_name,
          subject_code: row.subject_code,
          examResults: []
        };
      }
      
      subjectData[row.subject_id].examResults.push({
        examination_id: row.examination_id,
        exam_name: row.exam_name,
        start_date: row.start_date,
        marks_obtained: row.marks_obtained,
        grade: row.grade
      });
    });
    
    // Get overall trend
    const overallTrend = examResults.rows.map(row => ({
      exam_name: row.exam_name,
      start_date: row.start_date,
      average_marks: row.average_marks,
      position_in_class: row.position_in_class
    }));
    
    // Get strengths and weaknesses (best and worst subjects)
    const strengthsWeaknesses = await pool.query(
      `WITH SubjectAverages AS (
        SELECT 
          er.student_id,
          es.subject_id,
          s.name as subject_name,
          AVG(er.marks_obtained) as average_score,
          ROW_NUMBER() OVER (PARTITION BY er.student_id ORDER BY AVG(er.marks_obtained) DESC) as rank_high,
          ROW_NUMBER() OVER (PARTITION BY er.student_id ORDER BY AVG(er.marks_obtained) ASC) as rank_low
        FROM exam_results er
        JOIN exam_schedules es ON er.exam_schedule_id = es.id
        JOIN subjects s ON es.subject_id = s.id
        JOIN examinations e ON es.examination_id = e.id
        WHERE er.student_id = $1 ${sessionCondition} AND er.is_absent = false
        GROUP BY er.student_id, es.subject_id, s.name
      )
      SELECT 
        subject_id,
        subject_name,
        average_score,
        CASE 
          WHEN rank_high <= 3 THEN 'strength'
          WHEN rank_low <= 3 THEN 'weakness'
        END as category
      FROM SubjectAverages
      WHERE rank_high <= 3 OR rank_low <= 3
      ORDER BY average_score DESC`,
      params
    );
    
    // Compile the analytics
    const analytics = {
      student: studentDetails.rows[0],
      examResults: examResults.rows,
      subjectProgress: Object.values(subjectData),
      overallTrend,
      strengthsWeaknesses: strengthsWeaknesses.rows
    };
    
    res.json(analytics);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route   GET /api/analytics/subject-analysis/:subjectId
 * @desc    Get detailed analysis for a specific subject
 * @access  Private
 */
router.get('/subject-analysis/:subjectId', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const { subjectId } = req.params;
    const { class_id, academic_session_id } = req.query;
    
    if (!class_id || !academic_session_id) {
      return res.status(400).json({ msg: 'Class ID and Academic Session ID are required' });
    }
    
    // Get subject details
    const subjectDetails = await pool.query(
      `SELECT s.*, t.first_name || ' ' || t.last_name as teacher_name
       FROM subjects s
       LEFT JOIN teacher_subjects ts ON s.id = ts.subject_id AND ts.class_id = $2
       LEFT JOIN teachers t ON ts.teacher_id = t.id
       WHERE s.id = $1`,
      [subjectId, class_id]
    );
    
    if (subjectDetails.rows.length === 0) {
      return res.status(404).json({ msg: 'Subject not found' });
    }
    
    // Get exams in this academic session
    const exams = await pool.query(
      `SELECT e.*, et.name as exam_type_name
       FROM examinations e
       JOIN exam_types et ON e.exam_type_id = et.id
       WHERE e.academic_session_id = $1
       ORDER BY e.start_date`,
      [academic_session_id]
    );
    
    // Get performance by exam
    const examPerformance = await Promise.all(
      exams.rows.map(async (exam) => {
        const scheduleCheck = await pool.query(
          `SELECT id FROM exam_schedules 
           WHERE examination_id = $1 AND subject_id = $2 AND class_id = $3`,
          [exam.id, subjectId, class_id]
        );
        
        if (scheduleCheck.rows.length === 0) {
          return {
            exam,
            performance: null,
            gradeDistribution: null,
            topStudents: []
          };
        }
        
        const scheduleId = scheduleCheck.rows[0].id;
        
        const performance = await pool.query(
          `SELECT 
            COUNT(er.id) as total_students,
            ROUND(AVG(er.marks_obtained), 2) as average_score,
            MAX(er.marks_obtained) as highest_score,
            MIN(er.marks_obtained) as lowest_score,
            COUNT(CASE WHEN er.marks_obtained >= es.passing_marks THEN 1 END) as pass_count,
            COUNT(CASE WHEN er.marks_obtained < es.passing_marks THEN 1 END) as fail_count,
            ROUND(COUNT(CASE WHEN er.marks_obtained >= es.passing_marks THEN 1 END) * 100.0 / 
                 NULLIF(COUNT(er.id), 0), 2) as pass_percentage
          FROM exam_results er
          JOIN exam_schedules es ON er.exam_schedule_id = es.id
          WHERE es.id = $1 AND er.is_absent = false`,
          [scheduleId]
        );
        
        // Grade distribution
        const gradeDistribution = await pool.query(
          `SELECT 
            er.grade,
            COUNT(er.id) as count,
            ROUND(COUNT(er.id) * 100.0 / NULLIF((SELECT COUNT(*) FROM exam_results WHERE exam_schedule_id = $1 AND is_absent = false), 0), 2) as percentage
          FROM exam_results er
          WHERE er.exam_schedule_id = $1 AND er.is_absent = false
          GROUP BY er.grade
          ORDER BY er.grade`,
          [scheduleId]
        );
        
        // Top students
        const topStudents = await pool.query(
          `SELECT 
            er.student_id,
            s.first_name || ' ' || s.last_name as student_name,
            s.admission_number,
            er.marks_obtained,
            er.grade
          FROM exam_results er
          JOIN students s ON er.student_id = s.id
          WHERE er.exam_schedule_id = $1 AND er.is_absent = false
          ORDER BY er.marks_obtained DESC
          LIMIT 5`,
          [scheduleId]
        );
        
        return {
          exam,
          performance: performance.rows[0],
          gradeDistribution: gradeDistribution.rows,
          topStudents: topStudents.rows
        };
      })
    );
    
    // Get trend data
    const trendData = await pool.query(
      `SELECT 
        e.name as exam_name,
        e.start_date,
        ROUND(AVG(er.marks_obtained), 2) as average_score
      FROM exam_results er
      JOIN exam_schedules es ON er.exam_schedule_id = es.id
      JOIN examinations e ON es.examination_id = e.id
      WHERE es.subject_id = $1 AND es.class_id = $2 AND e.academic_session_id = $3 AND er.is_absent = false
      GROUP BY e.id, e.name, e.start_date
      ORDER BY e.start_date`,
      [subjectId, class_id, academic_session_id]
    );
    
    // Compile analytics
    const analytics = {
      subject: subjectDetails.rows[0],
      examPerformance: examPerformance.filter(ep => ep.performance !== null),
      trendData: trendData.rows
    };
    
    res.json(analytics);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

/**
 * @route   GET /api/analytics/school-performance
 * @desc    Get overall school performance analytics
 * @access  Private (Admin/Principal only)
 */
router.get('/school-performance', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const { academic_session_id } = req.query;
    
    if (!academic_session_id) {
      return res.status(400).json({ msg: 'Academic session ID is required' });
    }
    
    // Get academic session info
    const sessionInfo = await pool.query(
      `SELECT * FROM academic_sessions WHERE id = $1`,
      [academic_session_id]
    );
    
    if (sessionInfo.rows.length === 0) {
      return res.status(404).json({ msg: 'Academic session not found' });
    }
    
    // Get examinations in this academic session
    const exams = await pool.query(
      `SELECT e.*, et.name as exam_type_name
       FROM examinations e
       JOIN exam_types et ON e.exam_type_id = et.id
       WHERE e.academic_session_id = $1
       ORDER BY e.start_date`,
      [academic_session_id]
    );
    
    // Get overall performance by class
    const classPerformance = await pool.query(
      `SELECT 
        c.id as class_id,
        c.name as class_name,
        c.level,
        c.stream,
        COUNT(DISTINCT s.id) as student_count,
        ROUND(AVG(srs.average_marks), 2) as average_score,
        MAX(srs.average_marks) as highest_score,
        MIN(srs.average_marks) as lowest_score,
        COUNT(CASE WHEN srs.average_marks >= 70 THEN 1 END) as a_count,
        COUNT(CASE WHEN srs.average_marks >= 60 AND srs.average_marks < 70 THEN 1 END) as b_count,
        COUNT(CASE WHEN srs.average_marks >= 50 AND srs.average_marks < 60 THEN 1 END) as c_count,
        COUNT(CASE WHEN srs.average_marks >= 40 AND srs.average_marks < 50 THEN 1 END) as d_count,
        COUNT(CASE WHEN srs.average_marks < 40 THEN 1 END) as fail_count
      FROM classes c
      JOIN students s ON s.current_class = c.level AND s.stream = c.stream
      JOIN student_result_summary srs ON srs.student_id = s.id
      JOIN examinations e ON srs.examination_id = e.id
      WHERE c.academic_session_id = $1 AND e.academic_session_id = $1
      GROUP BY c.id, c.name, c.level, c.stream
      ORDER BY c.level, c.stream`,
      [academic_session_id]
    );
    
    // Get subject performance
    const subjectPerformance = await pool.query(
      `SELECT 
        s.id as subject_id,
        s.name as subject_name,
        s.code as subject_code,
        COUNT(DISTINCT er.student_id) as student_count,
        ROUND(AVG(er.marks_obtained), 2) as average_score,
        MAX(er.marks_obtained) as highest_score,
        MIN(er.marks_obtained) as lowest_score,
        COUNT(CASE WHEN er.marks_obtained >= es.passing_marks THEN 1 END) as pass_count,
        COUNT(CASE WHEN er.marks_obtained < es.passing_marks THEN 1 END) as fail_count
      FROM exam_results er
      JOIN exam_schedules es ON er.exam_schedule_id = es.id
      JOIN subjects s ON es.subject_id = s.id
      JOIN examinations e ON es.examination_id = e.id
      WHERE e.academic_session_id = $1 AND er.is_absent = false
      GROUP BY s.id, s.name, s.code
      ORDER BY average_score DESC`,
      [academic_session_id]
    );
    
    // Get trending data over the session
    const trendData = await pool.query(
      `SELECT 
        e.id as examination_id,
        e.name as exam_name,
        e.start_date,
        ROUND(AVG(srs.average_marks), 2) as average_score
      FROM student_result_summary srs
      JOIN examinations e ON srs.examination_id = e.id
      WHERE e.academic_session_id = $1
      GROUP BY e.id, e.name, e.start_date
      ORDER BY e.start_date`,
      [academic_session_id]
    );
    
    // Compile the analytics
    const analytics = {
      academicSession: sessionInfo.rows[0],
      exams: exams.rows,
      classPerformance: classPerformance.rows,
      subjectPerformance: subjectPerformance.rows,
      trendData: trendData.rows
    };
    
    res.json(analytics);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

export default router