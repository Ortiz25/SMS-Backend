// src/routes/academic.routes.js
import express from 'express';
import pool from '../config/database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';


const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);

// Get student academic info
router.get('/student/:id', authorizeRoles('admin', 'teacher', 'parent', 'staff'), async (req, res, next) => {
    try {
        const studentId = req.params.id;
        const academicSessionId = req.query.academicSessionId ||
            (await pool.query('SELECT id FROM academic_sessions WHERE is_current = true LIMIT 1')).rows[0]?.id;
        
        if (!academicSessionId) {
            return res.status(404).json({
                success: false,
                error: 'No active academic session found'
            });
        }

        // 1. Fetch basic student and class information
        const studentInfoQuery = `
            SELECT 
                s.id,
                s.first_name || ' ' || s.last_name AS name,
                s.admission_number,
                s.current_class,
                s.stream,
                c.name AS class_name
            FROM 
                students s
            LEFT JOIN 
                classes c ON s.current_class = c.level AND s.stream = c.stream
            WHERE 
                s.id = $1
                AND c.academic_session_id = $2
        `;

        // 2. Fetch examination results summary
        const resultSummaryQuery = `
            SELECT 
                srs.average_marks,
                srs.grade,
                srs.points,
                srs.position_in_class,
                srs.position_overall,
                srs.subjects_passed,
                srs.subjects_failed,
                e.name AS examination_name
            FROM 
                student_result_summary srs
            JOIN 
                examinations e ON srs.examination_id = e.id
            WHERE 
                srs.student_id = $1
                AND srs.academic_session_id = $2
            ORDER BY 
                e.end_date DESC
            LIMIT 1
        `;

        // 3. Fetch subject-wise performance
        const subjectPerformanceQuery = `
            SELECT 
                s.name AS subject_name,
                s.code AS subject_code,
                er.marks_obtained,
                er.grade,
                er.points,
                es.total_marks,
                ex.name AS exam_name
            FROM 
                exam_results er
            JOIN 
                exam_schedules es ON er.exam_schedule_id = es.id
            JOIN 
                subjects s ON es.subject_id = s.id
            JOIN 
                examinations ex ON es.examination_id = ex.id
            WHERE 
                er.student_id = $1
                AND ex.academic_session_id = $2
            ORDER BY 
                ex.end_date DESC, s.name
        `;

        // 4. Fetch attendance summary
        const attendanceSummaryQuery = `
            SELECT 
                present_days,
                absent_days,
                late_days,
                leave_days,
                total_school_days,
                attendance_percentage
            FROM 
                attendance_summary
            WHERE 
                student_id = $1
                AND academic_session_id = $2
        `;

        // 5. Fetch fee details
        const feeDetailsQuery = `
            SELECT 
                total_fee,
                paid_amount,
                balance,
                discount_amount,
                scholarship_amount,
                status AS payment_status,
                last_payment_date
            FROM 
                student_fee_details
            WHERE 
                student_id = $1
                AND academic_session_id = $2
        `;

        // Execute all queries in parallel
        const [
            studentInfo, 
            resultSummary, 
            subjectPerformance, 
            attendanceSummary, 
            feeDetails
        ] = await Promise.all([
            pool.query(studentInfoQuery, [studentId, academicSessionId]),
            pool.query(resultSummaryQuery, [studentId, academicSessionId]),
            pool.query(subjectPerformanceQuery, [studentId, academicSessionId]),
            pool.query(attendanceSummaryQuery, [studentId, academicSessionId]),
            pool.query(feeDetailsQuery, [studentId, academicSessionId])
        ]);

        // Group subjects by examination
        const subjectsByExam = {};
        subjectPerformance.rows.forEach(row => {
            if (!subjectsByExam[row.exam_name]) {
                subjectsByExam[row.exam_name] = [];
            }
            subjectsByExam[row.exam_name].push({
                subject: row.subject_name,
                score: row.marks_obtained,
                outOf: row.total_marks,
                grade: row.grade,
                points: row.points
            });
        });

        // Format the response
        res.json({
            success: true,
            data: {
                studentInfo: studentInfo.rows[0] || {},
                academicStatus: {
                    class: studentInfo.rows[0]?.class_name || null,
                    stream: studentInfo.rows[0]?.stream || null,
                    average_score: resultSummary.rows[0]?.average_marks || 0,
                    averageGrade: resultSummary.rows[0]?.grade || 'N/A',
                    position_in_class: resultSummary.rows[0]?.position_in_class || null,
                    position_overall: resultSummary.rows[0]?.position_overall || null,
                    subjects_passed: resultSummary.rows[0]?.subjects_passed || 0,
                    subjects_failed: resultSummary.rows[0]?.subjects_failed || 0,
                    examination: resultSummary.rows[0]?.examination_name || 'N/A'
                },
                attendance: attendanceSummary.rows[0] || {
                    present_days: 0,
                    absent_days: 0,
                    late_days: 0,
                    leave_days: 0,
                    total_school_days: 0,
                    attendance_percentage: 0
                },
                fees: feeDetails.rows[0] || {
                    total_fee: 0,
                    paid_amount: 0,
                    balance: 0,
                    discount_amount: 0,
                    scholarship_amount: 0,
                    payment_status: 'N/A',
                    last_payment_date: null
                },
                subjects: subjectsByExam
            }
        });
    } catch (error) {
        next(error);
    }
});

// Get current academic session
router.get('/current', async (req, res) => {
    try {
      const query = `
        SELECT id, year, term, start_date, end_date, is_current, status
        FROM academic_sessions
        WHERE is_current = true
        LIMIT 1
      `;
      
      const result = await pool.query(query);
      
      if (result.rows.length === 0) {
        return res.status(404).json({ message: 'No current academic session found' });
      }
      
      res.json(result.rows[0]);
    } catch (error) {
      console.error('Error fetching current academic session:', error);
      res.status(500).json({ message: 'Server error' });
    }
  });

  
export default router;