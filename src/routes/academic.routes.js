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
                s.curriculum_type,
                c.name AS class_name
            FROM 
                students s
            LEFT JOIN 
                classes c ON s.current_class = c.level AND s.stream = c.stream
            WHERE 
                s.id = $1
                
        `;

        // 2. Fetch examination results summary for current session
        const resultSummaryQuery = `
            SELECT 
                srs.average_marks,
                srs.grade,
                srs.points,
                srs.position_in_class,
                srs.position_overall,
                srs.subjects_passed,
                srs.subjects_failed,
                e.name AS examination_name,
                e.start_date,
                e.end_date
            FROM 
                student_result_summary srs
            JOIN 
                examinations e ON srs.examination_id = e.id
            WHERE 
                srs.student_id = $1
                AND srs.academic_session_id = $2
            ORDER BY 
                e.end_date DESC
        `;

        // 3. Fetch subject-wise performance for ALL sessions (current and previous)
        const subjectPerformanceQuery = `
            SELECT 
                s.name AS subject_name,
                s.code AS subject_code,
                er.marks_obtained,
                er.grade,
                er.points,
                es.total_marks,
                ex.name AS exam_name,
                ex.start_date,
                ex.end_date,
                acs.year,
                acs.term,
                CASE 
                    WHEN acs.id = $2 THEN 'Current'
                    ELSE 'Previous'
                END AS session_type
            FROM 
                exam_results er
            JOIN 
                exam_schedules es ON er.exam_schedule_id = es.id
            JOIN 
                subjects s ON es.subject_id = s.id
            JOIN 
                examinations ex ON es.examination_id = ex.id
            JOIN 
                academic_sessions acs ON ex.academic_session_id = acs.id
            WHERE 
                er.student_id = $1
            ORDER BY 
                acs.year DESC, acs.term DESC, ex.end_date DESC, s.name
        `;

        // 4. Fetch class promotion history
        const promotionHistoryQuery = `
            SELECT 
                sch.class_name AS from_class,
                sch.stream AS from_stream,
                sch.promotion_status,
                sch.promoted_on,
                sch.remarks,
                acs.year,
                acs.term,
                u.username AS promoted_by_user
            FROM 
                student_class_history sch
            JOIN 
                academic_sessions acs ON sch.academic_session_id = acs.id
            LEFT JOIN 
                users u ON sch.promoted_by = u.id
            WHERE 
                sch.student_id = $1
            ORDER BY 
                sch.promoted_on DESC
        `;

        // 5. Fetch attendance summary
        const attendanceSummaryQuery = `
            SELECT 
                present_days,
                absent_days,
                late_days,
                leave_days,
                total_school_days,
                attendance_percentage,
                acs.year,
                acs.term
            FROM 
                attendance_summary ats
            JOIN 
                academic_sessions acs ON ats.academic_session_id = acs.id
            WHERE 
                ats.student_id = $1
            ORDER BY 
                acs.year DESC, acs.term DESC
        `;

        // Execute all queries in parallel
        const [
            studentInfo, 
            resultSummary, 
            subjectPerformance, 
            promotionHistory,
            attendanceSummary
        ] = await Promise.all([
            pool.query(studentInfoQuery, [studentId]),
            pool.query(resultSummaryQuery, [studentId, academicSessionId]),
            pool.query(subjectPerformanceQuery, [studentId, academicSessionId]),
            pool.query(promotionHistoryQuery, [studentId]),
            pool.query(attendanceSummaryQuery, [studentId])
        ]);

        // Group subjects by examination and session
        const subjectsByExam = {};
        subjectPerformance.rows.forEach(row => {
            const examKey = `${row.exam_name} (${row.year} Term ${row.term}) - ${row.session_type}`;
            if (!subjectsByExam[examKey]) {
                subjectsByExam[examKey] = {
                    examName: row.exam_name,
                    year: row.year,
                    term: row.term,
                    sessionType: row.session_type,
                    subjects: []
                };
            }
            subjectsByExam[examKey].subjects.push({
                subject: row.subject_name,
                score: row.marks_obtained,
                outOf: row.total_marks,
                grade: row.grade,
                points: row.points
            });
        });

        // Format promotion history
        const formattedPromotions = promotionHistory.rows.map(promo => ({
            from_class: `${promo.from_class} ${promo.from_stream || ''}`.trim(),
            promotion_status: promo.promotion_status,
            promoted_on: promo.promoted_on,
            remarks: promo.remarks,
            academic_year: promo.year,
            term: promo.term,
            promoted_by: promo.promoted_by_user
        }));

        // Get current academic session result summary
        const currentResultSummary = resultSummary.rows[0] || {};

        // Format the response
        res.json({
            success: true,
            data: {
                studentInfo: studentInfo.rows[0] || {},
                academicStatus: {
                    class: studentInfo.rows[0]?.current_class || null,
                    stream: studentInfo.rows[0]?.stream || null,
                    curriculum_type: studentInfo.rows[0]?.curriculum_type || null,
                    average_score: currentResultSummary?.average_marks || 0,
                    averageGrade: currentResultSummary?.grade || 'N/A',
                    position_in_class: currentResultSummary?.position_in_class || null,
                    position_overall: currentResultSummary?.position_overall || null,
                    subjects_passed: currentResultSummary?.subjects_passed || 0,
                    subjects_failed: currentResultSummary?.subjects_failed || 0,
                    examination: currentResultSummary?.examination_name || 'N/A'
                },
                promotionHistory: formattedPromotions,
                attendance: attendanceSummary.rows || [],
                subjects: subjectsByExam,
                examSummaries: resultSummary.rows || []
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