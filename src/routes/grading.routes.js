import express from "express";
import pool from "../config/database.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";
import { check, validationResult } from "express-validator";

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);

/**
 * @route   GET /api/grading/classes
 * @desc    Get all classes with their respective teachers
 * @access  Private
 */
router.get(
  "/classes",
  authorizeRoles("admin", "teacher", "staff"),
  async (req, res) => {
    try {
      const { academic_session_id } = req.query;

      let query = `
      SELECT c.*, t.first_name || ' ' || t.last_name as class_teacher_name
      FROM classes c
      LEFT JOIN teachers t ON c.class_teacher_id = t.id
    `;

      const params = [];

      // if (academic_session_id) {
      //   query += ` WHERE c.academic_session_id = $1`;
      //   params.push(academic_session_id);
      // }

      query += ` ORDER BY c.level, c.stream`;

      const classes = await pool.query(query, params);

      res.json(classes.rows);
    } catch (err) {
      console.error(err.message);
      res.status(500).send("Server Error");
    }
  }
);

/**
 * @route   GET /api/grading/subjects/:classId
 * @desc    Get all subjects for a specific class
 * @access  Private
 */
router.get(
  "/subjects/:classId",
  authorizeRoles("admin", "teacher", "staff"),
  async (req, res) => {
    try {
      const { classId } = req.params;
      console.log("classId", classId);
      const subjects = await pool.query(
        `SELECT s.*, t.first_name || ' ' || t.last_name as teacher_name
       FROM subjects s
       JOIN teacher_subjects ts ON s.id = ts.subject_id
       JOIN teachers t ON ts.teacher_id = t.id
       WHERE ts.class_id = $1
       ORDER BY s.name`,
        [classId]
      );

      res.json(subjects.rows);
    } catch (err) {
      console.error(err.message);
      res.status(500).send("Server Error");
    }
  }
);

/**
 * @route   GET /api/grading/students/:classId
 * @desc    Get all students for a specific class
 * @access  Private
 */
router.get(
  "/students/:classId",
  authorizeRoles("admin", "teacher", "staff"),
  async (req, res) => {
    try {
      const { classId } = req.params;

      // Get class details first
      const classDetails = await pool.query(
        `SELECT * FROM classes WHERE id = $1`,
        [classId]
      );

      if (classDetails.rows.length === 0) {
        return res.status(404).json({ msg: "Class not found" });
      }

      const { level, stream } = classDetails.rows[0];

      // Get all students in this class
      const students = await pool.query(
        `SELECT 
    s.*,
    (
        SELECT ARRAY_AGG(sub.name)
        FROM student_subjects ss
        JOIN subjects sub ON ss.subject_id = sub.id
        WHERE ss.student_id = s.id
        AND ss.status = 'active'
    ) AS subjects
FROM 
    students s
WHERE 
    s.current_class = $1 
    AND s.stream = $2 
    AND s.status = 'active'
ORDER BY 
    s.last_name, s.first_name`,
        [level, stream]
      );

      res.json(students.rows);
    } catch (err) {
      console.error(err.message);
      res.status(500).send("Server Error");
    }
  }
);

/**
 * @route   POST /api/grading/bulk-entry
 * @desc    Enter grades in bulk for multiple students
 * @access  Private
 */
router.post(
  "/bulk-entry",
  authorizeRoles("admin", "teacher", "staff"),
  [
    check("exam_schedule_id", "Exam schedule ID is required").not().isEmpty(),
    check("grades", "Grades must be an array").isArray(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const { exam_schedule_id, grades } = req.body;

      // Get exam schedule to validate
      const scheduleResult = await client.query(
        `SELECT es.*, e.exam_type_id, et.grading_system_id
           FROM exam_schedules es
           JOIN examinations e ON es.examination_id = e.id
           JOIN exam_types et ON e.exam_type_id = et.id
           WHERE es.id = $1`,
        [exam_schedule_id]
      );

      if (scheduleResult.rows.length === 0) {
        return res.status(404).json({ msg: "Exam schedule not found" });
      }

      const { grading_system_id } = scheduleResult.rows[0];

      // Get grading system
      const gradesResult = await client.query(
        `SELECT * FROM grade_points 
           WHERE grading_system_id = $1
           ORDER BY lower_mark DESC`,
        [grading_system_id]
      );

      const gradePoints = gradesResult.rows;
      const results = [];

      for (const grade of grades) {
        const { student_id, marks, is_absent } = grade;

        // Calculate grade and points based on marks
        let letterGrade = null;
        let points = null;

        if (!is_absent && marks !== null) {
          for (const gp of gradePoints) {
            if (marks >= gp.lower_mark && marks <= gp.upper_mark) {
              letterGrade = gp.grade;
              points = gp.points;
              break;
            }
          }
        }

        // Check if result already exists
        const existingResult = await client.query(
          `SELECT * FROM exam_results WHERE student_id = $1 AND exam_schedule_id = $2`,
          [student_id, exam_schedule_id]
        );

        let result;

        if (existingResult.rows.length > 0) {
          // Update existing result
          result = await client.query(
            `UPDATE exam_results
               SET marks_obtained = $1, grade = $2, points = $3, is_absent = $4, updated_at = NOW()
               WHERE student_id = $5 AND exam_schedule_id = $6
               RETURNING *`,
            [
              marks,
              letterGrade,
              points,
              is_absent,
              student_id,
              exam_schedule_id,
            ]
          );
        } else {
          // Insert new result
          result = await client.query(
            `INSERT INTO exam_results (student_id, exam_schedule_id, marks_obtained, grade, points, is_absent)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING *`,
            [
              student_id,
              exam_schedule_id,
              marks,
              letterGrade,
              points,
              is_absent,
            ]
          );
        }

        results.push(result.rows[0]);
      }

      await client.query("COMMIT");
      res.json(results);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(err.message);
      res.status(500).send("Server Error");
    } finally {
      client.release();
    }
  }
);

/**
 * @route   GET /api/grading/student-grades/:studentId/:examId
 * @desc    Get grades for a specific student in a specific exam
 * @access  Private
 */
router.get(
  "/student-grades/:studentId/:examId",
  authorizeRoles("admin", "teacher", "staff"),
  async (req, res) => {
    try {
      const { studentId, examId } = req.params;

      const grades = await pool.query(
        `SELECT er.*, es.subject_id, s.name as subject_name, s.code as subject_code
       FROM exam_results er
       JOIN exam_schedules es ON er.exam_schedule_id = es.id
       JOIN subjects s ON es.subject_id = s.id
       WHERE er.student_id = $1 AND es.examination_id = $2
       ORDER BY s.name`,
        [studentId, examId]
      );

      res.json(grades.rows);
    } catch (err) {
      console.error(err.message);
      res.status(500).send("Server Error");
    }
  }
);

/**
 * @route   GET /api/grading/report-card/:studentId/:academicSessionId
 * @desc    Generate a report card for a student in a specific academic session
 * @access  Private
 */
router.get(
  "/report-card/:studentId/:academicSessionId",
  authorizeRoles("admin", "teacher", "staff"),
  async (req, res) => {
    try {
      const { studentId, academicSessionId } = req.params;

      // Get student info
      const studentInfo = await pool.query(
        `SELECT s.*, c.name as class_name, t.first_name || ' ' || t.last_name as class_teacher_name
       FROM students s
       JOIN classes c ON s.current_class = c.level AND s.stream = c.stream
       LEFT JOIN teachers t ON c.class_teacher_id = t.id
       WHERE s.id = $1`,
        [studentId]
      );

      if (studentInfo.rows.length === 0) {
        return res.status(404).json({ msg: "Student not found" });
      }

      // Get academic session info
      const sessionInfo = await pool.query(
        `SELECT * FROM academic_sessions WHERE id = $1`,
        [academicSessionId]
      );

      if (sessionInfo.rows.length === 0) {
        return res.status(404).json({ msg: "Academic session not found" });
      }

      // Get all exams in this academic session
      const exams = await pool.query(
        `SELECT e.*, et.name as exam_type_name
       FROM examinations e
       JOIN exam_types et ON e.exam_type_id = et.id
       WHERE e.academic_session_id = $1
       ORDER BY e.start_date`,
        [academicSessionId]
      );

      // Get exam results for each exam
      const examResults = await Promise.all(
        exams.rows.map(async (exam) => {
          // Get summary result
          const summaryResult = await pool.query(
            `SELECT * FROM student_result_summary
           WHERE student_id = $1 AND examination_id = $2`,
            [studentId, exam.id]
          );

          const summary = summaryResult.rows[0] || null;

          // Get subject results
          const subjectResults = await pool.query(
            `SELECT er.*, es.subject_id, s.name as subject_name, s.code as subject_code,
                  t.first_name || ' ' || t.last_name as teacher_name
           FROM exam_results er
           JOIN exam_schedules es ON er.exam_schedule_id = es.id
           JOIN subjects s ON es.subject_id = s.id
           LEFT JOIN teacher_subjects ts ON s.id = ts.subject_id AND ts.class_id = es.class_id
           LEFT JOIN teachers t ON ts.teacher_id = t.id
           WHERE er.student_id = $1 AND es.examination_id = $2
           ORDER BY s.name`,
            [studentId, exam.id]
          );

          return {
            exam: exam,
            summary: summary,
            subjectResults: subjectResults.rows,
          };
        })
      );

      // Get attendance summary for this academic session
      const attendanceSummary = await pool.query(
        `SELECT * FROM attendance_summary
       WHERE student_id = $1 AND academic_session_id = $2`,
        [studentId, academicSessionId]
      );

      // Get class teacher comments if available
      const commentQuery = await pool.query(
        `SELECT comments FROM student_result_summary
       WHERE student_id = $1 AND academic_session_id = $2
       ORDER BY id DESC LIMIT 1`,
        [studentId, academicSessionId]
      );

      const teacherComments =
        commentQuery.rows.length > 0 ? commentQuery.rows[0].comments : null;

      // Compile the complete report card
      const reportCard = {
        student: studentInfo.rows[0],
        academicSession: sessionInfo.rows[0],
        examResults: examResults,
        attendance: attendanceSummary.rows[0] || null,
        teacherComments: teacherComments,
      };

      res.json(reportCard);
    } catch (err) {
      console.error(err.message);
      res.status(500).send("Server Error");
    }
  }
);

/**
 * @route   POST /api/grading/batch-report-cards
 * @desc    Generate report cards for multiple students
 * @access  Private
 */
router.post(
  "/batch-report-cards",
  authorizeRoles("admin", "teacher", "staff"),
  async (req, res) => {
    try {
      const { class_id, academic_session_id } = req.body;

      if (!class_id || !academic_session_id) {
        return res
          .status(400)
          .json({ msg: "Class ID and Academic Session ID are required" });
      }

      // Get class details
      const classDetails = await pool.query(
        `SELECT * FROM classes WHERE id = $1`,
        [class_id]
      );

      if (classDetails.rows.length === 0) {
        return res.status(404).json({ msg: "Class not found" });
      }

      const { level, stream } = classDetails.rows[0];

      // Get all students in this class
      const students = await pool.query(
        `SELECT * FROM students 
       WHERE current_class = $1 AND stream = $2 AND status = 'active'
       ORDER BY last_name, first_name`,
        [level, stream]
      );

      // Generate report card IDs for all students
      const reportCards = students.rows.map((student) => ({
        student_id: student.id,
        academic_session_id,
        status: "generated",
        generated_at: new Date(),
        download_url: `/api/grading/report-card/${student.id}/${academic_session_id}`,
      }));

      res.json({
        message: `Successfully generated ${reportCards.length} report cards`,
        reportCards,
      });
    } catch (err) {
      console.error(err.message);
      res.status(500).send("Server Error");
    }
  }
);

/**
 * @route   POST /api/grading/teacher-comments
 * @desc    Add teacher comments to student results
 * @access  Private
 */
router.post(
  "/teacher-comments",
  authorizeRoles("admin", "teacher", "staff"),
  async (req, res) => {
    try {
      const { student_id, examination_id, comments } = req.body;

      if (!student_id || !examination_id) {
        return res
          .status(400)
          .json({ msg: "Student ID and Examination ID are required" });
      }

      // Check if summary exists
      const summaryCheck = await pool.query(
        `SELECT * FROM student_result_summary
       WHERE student_id = $1 AND examination_id = $2`,
        [student_id, examination_id]
      );

      if (summaryCheck.rows.length === 0) {
        return res.status(404).json({
          msg: "No result summary found for this student and examination",
        });
      }

      // Update the comments
      const result = await pool.query(
        `UPDATE student_result_summary
       SET comments = $1, updated_at = NOW()
       WHERE student_id = $2 AND examination_id = $3
       RETURNING *`,
        [comments, student_id, examination_id]
      );

      res.json(result.rows[0]);
    } catch (err) {
      console.error(err.message);
      res.status(500).send("Server Error");
    }
  }
);

/**
 * @route   GET /api/grading/sessions
 * @desc    Get all academic sessions
 * @access  Private
 */
router.get(
  "/sessions",
  authorizeRoles("admin", "teacher", "staff"),
  async (req, res) => {
    try {
      const sessions = await pool.query(
        `SELECT * FROM academic_sessions ORDER BY year DESC, term DESC`
      );

      res.json(sessions.rows);
    } catch (err) {
      console.error(err.message);
      res.status(500).send("Server Error");
    }
  }
);

/**
 * @route   GET /api/grading/current-session
 * @desc    Get the current academic session
 * @access  Private
 */
router.get(
  "/current-session",
  authorizeRoles("admin", "teacher", "staff"),
  async (req, res) => {
    try {
      const currentSession = await pool.query(
        `SELECT * FROM academic_sessions WHERE is_current = true LIMIT 1`
      );

      if (currentSession.rows.length === 0) {
        return res
          .status(404)
          .json({ msg: "No current academic session found" });
      }

      res.json(currentSession.rows[0]);
    } catch (err) {
      console.error(err.message);
      res.status(500).send("Server Error");
    }
  }
);

/**
 * @route   GET /api/grading/exam-subjects/:classId/:examId
 * @desc    Get subjects with scheduled exams for a specific class and examination
 * @access  Private
 */
router.get(
  "/exam-subjects/:classId/:examId",
  authorizeRoles("admin", "teacher", "staff"),
  async (req, res) => {
    try {
      const { classId, examId } = req.params;
      console.log(classId, examId)
      const subjects = await pool.query(
        `SELECT DISTINCT s.*, 
              COALESCE(t.first_name || ' ' || t.last_name, 'No Teacher Assigned') AS teacher_name
       FROM subjects s
       JOIN exam_schedules es ON s.id = es.subject_id
       JOIN examinations e ON es.examination_id = e.id
       LEFT JOIN teacher_subjects ts ON s.id = ts.subject_id 
                                      AND ts.class_id = es.class_id 
                                      AND ts.academic_session_id = e.academic_session_id
       LEFT JOIN teachers t ON ts.teacher_id = t.id
       WHERE es.class_id = $1 
         AND es.examination_id = $2
         AND es.exam_date <= CURRENT_DATE  -- Ensure the exam has already occurred
       ORDER BY s.name`,
        [classId, examId]
      );

      if (subjects.rows.length === 0) {
        return res
          .status(404)
          .json({ msg: "No subjects found for this class and exam." });
      }

      res.json(subjects.rows);
    } catch (err) {
      console.error(err.message);
      res.status(500).send("Server Error");
    }
  }
);

export default router;
