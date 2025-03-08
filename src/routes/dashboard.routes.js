// src/routes/dashboard.routes.js
import express from "express";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";
import pool from "../config/database.js";

const router = express.Router();

// Apply authentication middleware to all dashboard routes
router.use(authenticateToken);

/**
 * Get dashboard summary data
 * This endpoint aggregates all key data for the dashboard
 */
router.get("/summary", async (req, res, next) => {
  try {
    const isMinimal = req.query.minimal === "true";
    const client = await pool.connect();

    try {
      // Use a transaction to ensure data consistency
      await client.query("BEGIN");

      // Get current academic session
      const currentSessionResult = await client.query(
        "SELECT id, year, term FROM academic_sessions WHERE is_current = true"
      );

      if (currentSessionResult.rows.length === 0) {
        return res
          .status(404)
          .json({ error: "No active academic session found" });
      }

      const currentSession = currentSessionResult.rows[0];

      // If minimal is true, only fetch the essential data
      if (isMinimal) {
        // Get basic student statistics
        const studentStatsResult = await client.query(`
          SELECT
            COUNT(*) as total_students,
            COUNT(CASE WHEN gender = 'male' THEN 1 END) as male_students,
            COUNT(CASE WHEN gender = 'female' THEN 1 END) as female_students
          FROM students
        `);

        // Get basic teacher statistics
        const teacherStatsResult = await client.query(`
          SELECT COUNT(*) as total_teachers
          FROM teachers
        `);

        // Get basic class statistics
        const classStatsResult = await client.query(
          `
          SELECT COUNT(*) as total_classes
          FROM classes
          WHERE academic_session_id = $1
          `,
          [currentSession.id]
        );

        // Get today's simple attendance summary
        const today = new Date().toISOString().split("T")[0];
        const attendanceResult = await client.query(
          `
          SELECT
            COUNT(*) as total_marked,
            COUNT(CASE WHEN status = 'present' THEN 1 END) as present
          FROM attendance
          WHERE date = $1
          `,
          [today]
        );

        // Get library basic stats
        const libraryStatsResult = await client.query(`
          SELECT
            COUNT(*) as total_books,
            SUM(copies_available) as available_books
          FROM library_books
        `);

        // Get upcoming events (limited to 2)
        const upcomingEventsResult = await client.query(`
          SELECT
            id,
            title,
            event_date,
            start_time,
            end_time,
            location,
            event_type
          FROM events
          WHERE event_date >= CURRENT_DATE
          ORDER BY event_date, start_time
          LIMIT 2
        `);

        // Get recent activities (limited to 3)
        const recentActivitiesResult = await client.query(`
          (SELECT
            'New Student' as activity_type,
            first_name || ' ' || last_name as name,
            admission_number as reference,
            created_at as timestamp
          FROM students
          ORDER BY created_at DESC
          LIMIT 3)
          
          UNION ALL
          
          (SELECT
            'Fee Payment' as activity_type,
            s.first_name || ' ' || s.last_name as name,
            fp.receipt_number as reference,
            fp.created_at as timestamp
          FROM fee_payments fp
          JOIN students s ON fp.student_id = s.id
          ORDER BY fp.created_at DESC
          LIMIT 3)
          
          ORDER BY timestamp DESC
          LIMIT 5
        `);

        await client.query("COMMIT");

        // Return minimal data set
        return res.json({
          academic_session: currentSession,
          student_stats: studentStatsResult.rows[0],
          teacher_stats: teacherStatsResult.rows[0],
          class_stats: classStatsResult.rows[0],
          attendance_today: attendanceResult.rows[0],
          library_stats: libraryStatsResult.rows[0],
          upcoming_events: upcomingEventsResult.rows,
          recent_activities: recentActivitiesResult.rows,
          is_minimal: true,
        });
      }

      // If not minimal, fetch the full dashboard data
      // Get student statistics
      const studentStatsResult = await client.query(`
        SELECT
          COUNT(*) as total_students,
          COUNT(CASE WHEN gender = 'male' THEN 1 END) as male_students,
          COUNT(CASE WHEN gender = 'female' THEN 1 END) as female_students,
          COUNT(CASE WHEN status = 'active' THEN 1 END) as active_students,
          COUNT(CASE WHEN status != 'active' THEN 1 END) as inactive_students
        FROM students
      `);

      // Get teacher statistics
      const teacherStatsResult = await client.query(`
        SELECT
          COUNT(*) as total_teachers,
          COUNT(CASE WHEN status = 'active' THEN 1 END) as active_teachers
        FROM teachers
      `);

      // Get class statistics
      const classStatsResult = await client.query(
        `
        SELECT
          COUNT(*) as total_classes,
          COUNT(DISTINCT level) as grade_levels
        FROM classes
        WHERE academic_session_id = $1
        `,
        [currentSession.id]
      );

      // Get today's attendance summary
      const today = new Date().toISOString().split("T")[0];
      const attendanceResult = await client.query(
        `
        SELECT
          COUNT(*) as total_marked,
          COUNT(CASE WHEN status = 'present' THEN 1 END) as present,
          COUNT(CASE WHEN status = 'absent' THEN 1 END) as absent,
          COUNT(CASE WHEN status = 'late' THEN 1 END) as late
        FROM attendance
        WHERE date = $1
        `,
        [today]
      );

      // Get fee collection summary for current term
      const feeResult = await client.query(
        `
        WITH total_fees AS (
          SELECT SUM(total_fee) as total_amount
          FROM student_fee_details
          WHERE academic_session_id = $1
        ),
        collected_fees AS (
          SELECT SUM(amount) as collected_amount
          FROM fee_payments
          WHERE academic_session_id = $1
          AND payment_status = 'success'
        )
        SELECT
          COALESCE(tf.total_amount, 0) as total_fees,
          COALESCE(cf.collected_amount, 0) as collected_fees
        FROM total_fees tf, collected_fees cf
        `,
        [currentSession.id]
      );

      // Get recent activities
      const recentActivitiesResult = await client.query(`
        (SELECT
          'New Student' as activity_type,
          first_name || ' ' || last_name as name,
          admission_number as reference,
          created_at as timestamp
        FROM students
        ORDER BY created_at DESC
        LIMIT 5)
        
        UNION ALL
        
        (SELECT
          'Fee Payment' as activity_type,
          s.first_name || ' ' || s.last_name as name,
          fp.receipt_number as reference,
          fp.created_at as timestamp
        FROM fee_payments fp
        JOIN students s ON fp.admission_number = s.admission_number
        ORDER BY fp.created_at DESC
        LIMIT 5)
        
        UNION ALL
        
        (SELECT
          'Attendance Marked' as activity_type,
          u.username as name,
          c.name as reference,
          a.created_at as timestamp
        FROM attendance a
        JOIN users u ON a.recorded_by = u.id
        JOIN classes c ON a.class_id = c.id
        GROUP BY u.username, c.name, a.created_at
        ORDER BY a.created_at DESC
        LIMIT 5)
        
        UNION ALL
        
        (SELECT
          'Event Created' as activity_type,
          u.username as name,
          e.title as reference,
          e.created_at as timestamp
        FROM events e
        JOIN users u ON e.created_by = u.id
        ORDER BY e.created_at DESC
        LIMIT 5)
        
        ORDER BY timestamp DESC
        LIMIT 10
      `);

      // Get upcoming events with proper schema fields
      const upcomingEventsResult = await client.query(`
        SELECT
          e.id,
          e.title,
          e.description,
          e.event_date,
          e.start_time,
          e.end_time,
          e.location,
          e.event_type,
          e.is_public,
          u.username as created_by_name
        FROM events e
        JOIN users u ON e.created_by = u.id
        WHERE e.event_date >= CURRENT_DATE
        ORDER BY e.event_date, e.start_time
        LIMIT 5
      `);
      
      // Get event statistics
      const eventStatsResult = await client.query(`
        SELECT
          COUNT(*) as total_events,
          COUNT(CASE WHEN event_date >= CURRENT_DATE THEN 1 END) as upcoming_events,
          COUNT(CASE WHEN event_date < CURRENT_DATE THEN 1 END) as past_events,
          COUNT(CASE WHEN event_type = 'academic' THEN 1 END) as academic_events,
          COUNT(CASE WHEN event_type = 'sports' THEN 1 END) as sports_events,
          COUNT(CASE WHEN event_type = 'cultural' THEN 1 END) as cultural_events,
          COUNT(CASE WHEN is_public = true THEN 1 END) as public_events
        FROM events
      `);

      // Get events by month for the current year
      const eventsByMonthResult = await client.query(`
        SELECT
          EXTRACT(MONTH FROM event_date) as month,
          COUNT(*) as count
        FROM events
        WHERE EXTRACT(YEAR FROM event_date) = EXTRACT(YEAR FROM CURRENT_DATE)
        GROUP BY month
        ORDER BY month
      `);

      // Get attendance trend for the last 7 days
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const formattedSevenDaysAgo = sevenDaysAgo.toISOString().split("T")[0];

      const attendanceTrendResult = await client.query(
        `
        SELECT
          date,
          COUNT(*) as total_marked,
          COUNT(CASE WHEN status = 'present' THEN 1 END) as present,
          COUNT(CASE WHEN status = 'absent' THEN 1 END) as absent,
          COUNT(CASE WHEN status = 'late' THEN 1 END) as late
        FROM attendance
        WHERE date >= $1
        GROUP BY date
        ORDER BY date
        `,
        [formattedSevenDaysAgo]
      );

      // Get student enrollment trend by month for current year
      const enrollmentTrendResult = await client.query(`
        SELECT
          EXTRACT(MONTH FROM admission_date) as month,
          COUNT(*) as count
        FROM students
        WHERE EXTRACT(YEAR FROM admission_date) = EXTRACT(YEAR FROM CURRENT_DATE)
        GROUP BY month
        ORDER BY month
      `);

      // Get library summary
      const libraryStatsResult = await client.query(`
        SELECT
          COUNT(*) as total_books,
          SUM(copies_available) as available_books,
          COUNT(*) - SUM(copies_available) as borrowed_books
        FROM library_books
      `);

      // Check if the academic_records table exists - since it's not in your schema
      const academicRecordsTableExists = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'academic_records'
        );
      `);

      let formPerformanceResult = { rows: [] };

      // If academic_records doesn't exist, use exam_results instead
      if (!academicRecordsTableExists.rows[0].exists) {
        formPerformanceResult = await client.query(`
          SELECT 
            c.curriculum_type,
            CASE 
              WHEN c.curriculum_type = '844' THEN 'Form '
              WHEN c.curriculum_type = 'CBC' THEN 'Grade '
            END || c.level as form,
            ROUND(AVG(er.marks_obtained), 2) as average,
            CASE 
              WHEN AVG(er.marks_obtained) >= 75 THEN 'up'
              WHEN AVG(er.marks_obtained) >= 60 THEN 'stable'
              ELSE 'down'
            END as trend,
            CASE 
              WHEN AVG(er.marks_obtained) >= 80 THEN 'Above average'
              WHEN AVG(er.marks_obtained) >= 70 AND AVG(er.marks_obtained) < 80 THEN 'Average'
              ELSE 'Below average'
            END as status
          FROM exam_results er
          JOIN exam_schedules es ON er.exam_schedule_id = es.id
          JOIN examinations e ON es.examination_id = e.id
          JOIN classes c ON es.class_id = c.id
          WHERE e.academic_session_id = $1
          GROUP BY c.curriculum_type, c.level
          ORDER BY c.curriculum_type, c.level
        `, [currentSession.id]);
      }

      // Commit transaction
      await client.query("COMMIT");

      // Combine all data into a single response
      res.json({
        academic_session: currentSession,
        student_stats: studentStatsResult.rows[0],
        teacher_stats: teacherStatsResult.rows[0],
        class_stats: classStatsResult.rows[0],
        attendance_today: attendanceResult.rows[0],
        fee_summary: feeResult.rows[0],
        recent_activities: recentActivitiesResult.rows,
        upcoming_events: upcomingEventsResult.rows,
        event_stats: eventStatsResult.rows[0],
        events_by_month: eventsByMonthResult.rows,
        attendance_trend: attendanceTrendResult.rows,
        enrollment_trend: enrollmentTrendResult.rows,
        library_stats: libraryStatsResult.rows[0],
        form_performance: formPerformanceResult.rows,
        is_minimal: false,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});
/**
 * Get student attendance summary
 */
router.get(
  "/attendance",
  authorizeRoles("admin", "teacher"),
  async (req, res, next) => {
    try {
      const { class_id, date } = req.query;

      // Validate required parameters
      if (!class_id) {
        return res.status(400).json({ error: "Class ID is required" });
      }

      const attendanceDate = date || new Date().toISOString().split("T")[0];

      const query = `
            SELECT 
                a.id,
                s.admission_number,
                s.first_name,
                s.last_name,
                a.status,
                a.session_type,
                a.late_minutes,
                u.username as recorded_by
            FROM students s
            LEFT JOIN attendance a ON 
                s.id = a.student_id AND 
                a.date = $1 AND 
                a.class_id = $2
            LEFT JOIN users u ON a.recorded_by = u.id
            WHERE s.current_class = $2
            ORDER BY s.admission_number
        `;

      const result = await pool.query(query, [attendanceDate, class_id]);

      res.json({
        date: attendanceDate,
        class_id,
        attendance: result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);
/**
 * Get fee collection summary
 */
router.get(
  "/fees",
  authorizeRoles("admin", "accountant"),
  async (req, res, next) => {
    try {
      const { academic_session_id } = req.query;

      // Get current academic session if not provided
      let sessionId = academic_session_id;
      if (!sessionId) {
        const sessionResult = await pool.query(
          "SELECT id FROM academic_sessions WHERE is_current = true"
        );

        if (sessionResult.rows.length === 0) {
          return res
            .status(404)
            .json({ error: "No active academic session found" });
        }

        sessionId = sessionResult.rows[0].id;
      }

      // Get fee collection summary by category
      const feesByCategoryQuery = `
            SELECT 
                fc.name as category,
                SUM(fs.amount) as total_amount,
                COALESCE(SUM(fp.amount), 0) as collected_amount
            FROM fee_categories fc
            JOIN fee_structure fs ON fc.id = fs.fee_category_id
            LEFT JOIN fee_payments fp ON fs.id = fp.fee_structure_id AND fp.payment_status = 'success'
            WHERE fs.academic_session_id = $1
            GROUP BY fc.name
            ORDER BY fc.name
        `;

      const feesByCategoryResult = await pool.query(feesByCategoryQuery, [
        sessionId,
      ]);

      // Get fee collection summary by class
      const feesByClassQuery = `
            SELECT 
                c.name as class_name,
                SUM(fs.amount) as total_amount,
                COALESCE(SUM(fp.amount), 0) as collected_amount
            FROM classes c
            JOIN fee_structure fs ON c.id = fs.class_id
            LEFT JOIN fee_payments fp ON fs.id = fp.fee_structure_id AND fp.payment_status = 'success'
            WHERE fs.academic_session_id = $1
            GROUP BY c.name
            ORDER BY c.name
        `;

      const feesByClassResult = await pool.query(feesByClassQuery, [sessionId]);

      // Get recent payments
      const recentPaymentsQuery = `
            SELECT 
                fp.id,
                s.admission_number,
                s.first_name || ' ' || s.last_name as student_name,
                c.name as class_name,
                fp.amount,
                fp.payment_date,
                fp.payment_method,
                fp.receipt_number,
                fp.payment_status
            FROM fee_payments fp
            JOIN students s ON fp.student_id = s.id
            JOIN classes c ON s.current_class = c.id
            JOIN fee_structure fs ON fp.fee_structure_id = fs.id
            WHERE fs.academic_session_id = $1
            ORDER BY fp.payment_date DESC
            LIMIT 10
        `;

      const recentPaymentsResult = await pool.query(recentPaymentsQuery, [
        sessionId,
      ]);

      res.json({
        academic_session_id: sessionId,
        fees_by_category: feesByCategoryResult.rows,
        fees_by_class: feesByClassResult.rows,
        recent_payments: recentPaymentsResult.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Get exam results summary
 */
router.get(
  "/exams",
  authorizeRoles("admin", "teacher"),
  async (req, res, next) => {
    try {
      const { academic_session_id, exam_type_id } = req.query;

      // Validate required parameters
      if (!academic_session_id || !exam_type_id) {
        return res.status(400).json({
          error: "Academic session ID and exam type ID are required",
        });
      }

      // Get class performance
      const classPerformanceQuery = `
            SELECT 
                c.name as class_name,
                ROUND(AVG(ar.marks_obtained), 2) as average_marks,
                COUNT(DISTINCT ar.student_id) as total_students,
                COUNT(DISTINCT s.id) as class_strength,
                MAX(ar.marks_obtained) as highest_mark,
                MIN(ar.marks_obtained) as lowest_mark
            FROM classes c
            JOIN examinations e ON c.id = e.class_id
            JOIN academic_records ar ON e.id = ar.examination_id
            JOIN students s ON s.current_class = c.id
            WHERE e.academic_session_id = $1
            AND e.exam_type_id = $2
            GROUP BY c.name
            ORDER BY average_marks DESC
        `;

      const classPerformanceResult = await pool.query(classPerformanceQuery, [
        academic_session_id,
        exam_type_id,
      ]);

      // Get subject performance
      const subjectPerformanceQuery = `
            SELECT 
                s.name as subject_name,
                ROUND(AVG(ar.marks_obtained), 2) as average_marks,
                COUNT(ar.id) as total_students,
                MAX(ar.marks_obtained) as highest_mark,
                MIN(ar.marks_obtained) as lowest_mark
            FROM subjects s
            JOIN examinations e ON s.id = e.subject_id
            JOIN academic_records ar ON e.id = ar.examination_id
            WHERE e.academic_session_id = $1
            AND e.exam_type_id = $2
            GROUP BY s.name
            ORDER BY average_marks DESC
        `;

      const subjectPerformanceResult = await pool.query(
        subjectPerformanceQuery,
        [academic_session_id, exam_type_id]
      );

      // Get top performing students
      const topStudentsQuery = `
            WITH student_averages AS (
                SELECT 
                    s.id,
                    s.admission_number,
                    s.first_name || ' ' || s.last_name as student_name,
                    c.name as class_name,
                    ROUND(AVG(ar.marks_obtained), 2) as average_marks,
                    COUNT(ar.id) as subjects_count
                FROM students s
                JOIN classes c ON s.current_class = c.id
                JOIN academic_records ar ON s.id = ar.student_id
                JOIN examinations e ON ar.examination_id = e.id
                WHERE e.academic_session_id = $1
                AND e.exam_type_id = $2
                GROUP BY s.id, s.admission_number, s.first_name, s.last_name, c.name
                HAVING COUNT(ar.id) >= 3
            )
            SELECT * FROM student_averages
            ORDER BY average_marks DESC
            LIMIT 10
        `;

      const topStudentsResult = await pool.query(topStudentsQuery, [
        academic_session_id,
        exam_type_id,
      ]);

      res.json({
        academic_session_id,
        exam_type_id,
        class_performance: classPerformanceResult.rows,
        subject_performance: subjectPerformanceResult.rows,
        top_students: topStudentsResult.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get('/', authorizeRoles("admin", "teacher"),async (req, res) => {
  try {
    // Execute all queries in parallel for better performance
    const [
      totalStudentsResult,
      totalTeachersResult,
      upcomingEventsResult,
      classPerformanceResult,
      libraryBooksResult,
      transportUsageResult,
      attendanceDataResult,
      recentActivitiesResult
    ] = await Promise.all([
      getTotalStudents(),
      getTotalTeachers(),
      getUpcomingEvents(),
      getClassPerformance(),
      getLibraryBooks(),
      getTransportUsage(),
      getAttendanceData(),
      getRecentActivities()
    ]);

    res.json({
      totalStudents: totalStudentsResult,
      totalTeachers: totalTeachersResult,
      upcomingEvents: upcomingEventsResult,
      classPerformance: classPerformanceResult,
      libraryBooks: libraryBooksResult,
      transportUsage: transportUsageResult,
      attendanceData: attendanceDataResult,
      recentActivities: recentActivitiesResult
    });
  } catch (error) {
    console.error('Dashboard data error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// Get total students with growth percentage
async function getTotalStudents() {
  // Get current academic session
  const currentSessionResult = await pool.query(
    'SELECT id, year, term FROM academic_sessions WHERE is_current = TRUE'
  );
  const currentSession = currentSessionResult.rows[0];
  
  // If no current session, return default data
  if (!currentSession) {
    return { count: 0, growth: 0 };
  }
  
  // Get total active students
  const totalStudentsResult = await pool.query(
    'SELECT COUNT(*) FROM students WHERE status = $1',
    ['active']
  );
  const totalStudents = parseInt(totalStudentsResult.rows[0].count);
  
  // Get previous term data to calculate growth
  const prevTermResult = await pool.query(
    `SELECT id, year, term FROM academic_sessions 
     WHERE (year = $1 AND term < $2) 
     OR (year < $1) 
     ORDER BY year DESC, term DESC 
     LIMIT 1`,
    [currentSession.year, currentSession.term]
  );
  
  let growth = 0;
  
  // Calculate growth if previous term exists
  if (prevTermResult.rows.length > 0) {
    const prevTermId = prevTermResult.rows[0].id;
    
    const prevTermStudentsResult = await pool.query(
      `SELECT COUNT(DISTINCT student_id) 
       FROM student_subjects 
       WHERE academic_session_id = $1`,
      [prevTermId]
    );
    
    const prevTermStudents = parseInt(prevTermStudentsResult.rows[0].count);
    
    if (prevTermStudents > 0) {
      growth = ((totalStudents - prevTermStudents) / prevTermStudents) * 100;
    }
  }
  
  return {
    count: totalStudents,
    growth: parseFloat(growth.toFixed(1))
  };
}

// Get total teachers with new additions this month
async function getTotalTeachers() {
  const currentDate = new Date();
  const firstDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
  
  // Get total active teachers
  const totalTeachersResult = await pool.query(
    'SELECT COUNT(*) FROM teachers WHERE status = $1',
    ['active']
  );
  
  // Get new teachers added this month
  const newTeachersResult = await pool.query(
    'SELECT COUNT(*) FROM teachers WHERE created_at >= $1',
    [firstDayOfMonth]
  );
  
  return {
    count: parseInt(totalTeachersResult.rows[0].count),
    newAdditions: parseInt(newTeachersResult.rows[0].count)
  };
}

// Get upcoming events (could be from a separate events table in a real app)
// Here we'll simulate with examination schedules
async function getUpcomingEvents() {
  const upcomingExams = await pool.query(
    `SELECT 
      e.name, 
      es.exam_date, 
      es.start_time,
      s.name as subject_name
     FROM exam_schedules es
     JOIN examinations e ON es.examination_id = e.id
     JOIN subjects s ON es.subject_id = s.id
     WHERE es.exam_date >= CURRENT_DATE
     ORDER BY es.exam_date, es.start_time
     LIMIT 2`
  );
  
  // Format the events for the dashboard
  // For demo purposes, we'll create two events: Sports Day and Science Fair
  return [
    {
      title: "Sports Day",
      date: new Date(new Date().setDate(new Date().getDate() + 5)), // 5 days from now
      time: "9:00 AM",
      category: "Sports"
    },
    {
      title: "Science Fair",
      date: new Date(new Date().setDate(new Date().getDate() + 10)), // 10 days from now
      time: "1:00 PM",
      category: "Academic"
    }
  ];
}

// Get class performance data
async function getClassPerformance() {
  // Get current academic session
  const currentSessionResult = await pool.query(
    'SELECT id FROM academic_sessions WHERE is_current = TRUE'
  );
  
  if (currentSessionResult.rows.length === 0) {
    return [];
  }
  
  const sessionId = currentSessionResult.rows[0].id;
  
  // Get performance by form level for the current session
  const performanceData = await pool.query(
    `SELECT 
      CASE 
        WHEN c.level LIKE 'Form%' THEN substring(c.level, 6, 1)
        ELSE '0'
      END as form_level,
      AVG(srs.average_marks) as average_score
     FROM student_result_summary srs
     JOIN classes c ON srs.class_id = c.id
     WHERE srs.academic_session_id = $1
       AND c.level LIKE 'Form%'
     GROUP BY form_level
     ORDER BY form_level`,
    [sessionId]
  );
  
  // Format the performance data
  const formattedData = performanceData.rows.map(row => {
    const score = parseFloat(row.average_score || 0).toFixed(0);
    let status = 'Below average';
    
    if (score >= 80) {
      status = 'Above average';
    } else if (score >= 70 && score < 80) {
      status = 'Average';
    }
    
    return {
      form: `Form ${row.form_level}`,
      score: score,
      status: status
    };
  });
  
  // If we don't have real data, provide dummy data for the dashboard
  if (formattedData.length === 0) {
    return [
      { form: 'Form 1', score: '82', status: 'Above average' },
      { form: 'Form 2', score: '78', status: 'Below average' },
      { form: 'Form 3', score: '85', status: 'Above average' },
      { form: 'Form 4', score: '88', status: 'Above average' }
    ];
  }
  
  return formattedData;
}

// Get library books borrowed count
async function getLibraryBooks() {
  const currentDate = new Date();
  const firstDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
  
  // Get books borrowed this month
  const booksResult = await pool.query(
    `SELECT COUNT(*) 
     FROM book_borrowing
     WHERE borrow_date >= $1
       AND status IN ('borrowed', 'overdue')`,
    [firstDayOfMonth]
  );
  
  return {
    count: parseInt(booksResult.rows[0].count),
    period: 'This month'
  };
}

// Get transport usage percentage
async function getTransportUsage() {
  // Count students using school transport
  const transportUsersResult = await pool.query(
    `SELECT COUNT(*) 
     FROM transport_allocations
     WHERE status = 'active'`
  );
  
  // Count total day scholars
  const dayScholarsResult = await pool.query(
    `SELECT COUNT(*) 
     FROM students
     WHERE student_type = 'day_scholar'
       AND status = 'active'`
  );
  
  const transportUsers = parseInt(transportUsersResult.rows[0].count);
  const dayScholars = parseInt(dayScholarsResult.rows[0].count);
  
  let percentage = 0;
  if (dayScholars > 0) {
    percentage = Math.round((transportUsers / dayScholars) * 100);
  }
  
  return {
    percentage: percentage,
    description: 'Students using school buses'
  };
}

// Get attendance data for the chart
async function getAttendanceData() {
  // In a real app, this would fetch actual attendance data by week
  // For demo, we'll generate sample data for 3 terms
  
  // Generate weekly attendance for 3 terms (13-14 weeks each)
  const term1Data = Array.from({ length: 13 }, (_, i) => ({
    week: `Week ${i + 1}`,
    term: 'Term 1',
    attendance: Math.floor(Math.random() * (470 - 430) + 430)
  }));
  
  const term2Data = Array.from({ length: 14 }, (_, i) => ({
    week: `Week ${i + 14}`,
    term: 'Term 2',
    attendance: Math.floor(Math.random() * (470 - 430) + 430)
  }));
  
  const term3Data = Array.from({ length: 14 }, (_, i) => ({
    week: `Week ${i + 28}`,
    term: 'Term 3',
    attendance: Math.floor(Math.random() * (470 - 430) + 430)
  }));
  
  return {
    terms: [
      { id: 1, name: 'Term 1', period: '(Jan - March)' },
      { id: 2, name: 'Term 2', period: '(May - July)' },
      { id: 3, name: 'Term 3', period: '(Sept - Nov)' }
    ],
    weeklyData: [...term1Data, ...term2Data, ...term3Data]
  };
}

// Get recent activities
async function getRecentActivities() {
  // Get latest student admission
  const newStudentResult = await pool.query(
    `SELECT first_name, last_name, created_at
     FROM students
     ORDER BY created_at DESC
     LIMIT 1`
  );
  
  // Recent activities would typically come from an activity log table
  // For demo purposes, we'll create sample activities
  const activities = [];
  
  if (newStudentResult.rows.length > 0) {
    const student = newStudentResult.rows[0];
    activities.push({
      type: 'student_admission',
      title: `New student admission - ${student.first_name} ${student.last_name}`,
      timestamp: student.created_at,
      timeAgo: '2 hours ago'
    });
  }
  
  // Add more sample activities
  activities.push(
    {
      type: 'parent_meeting',
      title: 'Parent meeting scheduled for Form 4',
      timestamp: new Date(Date.now() - 5 * 60 * 60 * 1000), // 5 hours ago
      timeAgo: '5 hours ago'
    },
    {
      type: 'library',
      title: 'New books added to library inventory',
      timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 day ago
      timeAgo: '1 day ago'
    }
  );
  
  return activities;
}

router.get('/form-performance',authorizeRoles("admin", "teacher"), async (req, res) => {
  try {
    // Get current academic session
    const sessionResult = await pool.query(
      'SELECT id FROM academic_sessions WHERE is_current = true LIMIT 1'
    );
    
    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'No current academic session found' });
    }
    
    const currentSessionId = sessionResult.rows[0].id;
    
    // Get previous academic session (for trend comparison)
    const previousSessionResult = await pool.query(
      `SELECT id FROM academic_sessions 
       WHERE term = (
         SELECT term FROM academic_sessions WHERE id = $1
       ) 
       AND year::integer < (
         SELECT year::integer FROM academic_sessions WHERE id = $1
       )
       ORDER BY year::integer DESC, term DESC
       LIMIT 1`,
      [currentSessionId]
    );
    
    const previousSessionId = previousSessionResult.rows.length > 0 ? 
      previousSessionResult.rows[0].id : null;
    
    // Get all distinct class names/levels from the classes table
    const classLevelsResult = await pool.query(
      `SELECT DISTINCT level 
       FROM classes 
       WHERE academic_session_id = $1
       AND level IS NOT NULL
       ORDER BY level`,
      [currentSessionId]
    );
    
    // Extract all class levels, or use default forms if none exist
    const allClassLevels = classLevelsResult.rows.length > 0 
      ? classLevelsResult.rows.map(row => row.level) 
      : ['Form 1', 'Form 2', 'Form 3', 'Form 4'];
    
    // Query to get current performance by class level
    const currentResults = await pool.query(
      `SELECT 
         c.level as class_level,
         ROUND(AVG(srs.average_marks), 2) as average_marks
       FROM student_result_summary srs
       JOIN classes c ON srs.class_id = c.id
       JOIN examinations e ON srs.examination_id = e.id
       WHERE e.academic_session_id = $1
       GROUP BY class_level
       ORDER BY class_level`,
      [currentSessionId]
    );
    
    // If there's a previous session, get that data for trend comparison
    let previousResults = [];
    if (previousSessionId) {
      previousResults = await pool.query(
        `SELECT 
           c.level as class_level,
           ROUND(AVG(srs.average_marks), 2) as average_marks
         FROM student_result_summary srs
         JOIN classes c ON srs.class_id = c.id
         JOIN examinations e ON srs.examination_id = e.id
         WHERE e.academic_session_id = $1
         GROUP BY class_level
         ORDER BY class_level`,
        [previousSessionId]
      );
    }
    
    // Get overall average across all forms for the current session
    const overallAvgResult = await pool.query(
      `SELECT ROUND(AVG(srs.average_marks), 2) as overall_average
       FROM student_result_summary srs
       JOIN examinations e ON srs.examination_id = e.id
       WHERE e.academic_session_id = $1`,
      [currentSessionId]
    );
    
    const overallAverage = overallAvgResult.rows[0]?.overall_average || 0;
    
    // Format the response, ensuring all class levels are included even without data
    const formData = allClassLevels.map(classLevel => {
      // Find matching current data for this class level
      const current = currentResults.rows.find(c => c.class_level === classLevel);
      
      // If no data exists for this class level, create default values
      if (!current) {
        return {
          form: classLevel,
          average: 0,
          trend: "stable",
          status: "No data",
        };
      }
      
      // Find matching previous data for this class level
      const previous = previousResults.rows.find(p => p.class_level === current.class_level);
      
      // Determine trend
      let trend = "stable";
      if (previous) {
        trend = current.average_marks > previous.average_marks ? "up" : 
               current.average_marks < previous.average_marks ? "down" : "stable";
      }
      
      // Determine status compared to overall average
      const status = current.average_marks >= overallAverage ? "Above average" : "Below average";
      
      return {
        form: current.class_level,
        average: parseFloat(current.average_marks),
        trend,
        status,
        // You could add more data points here as needed
      };
    });
    
    res.json(formData);
    
  } catch (error) {
    console.error('Error fetching form performance data:', error);
    res.status(500).json({ error: 'Failed to fetch form performance data' });
  }
});

/**
 * GET /api/analytics/form-performance/:classLevel
 * Retrieves detailed performance data for a specific class level
 */
router.get('/form-performance/:classLevel', authorizeRoles("admin", "teacher"),async (req, res) => {
  try {
    const { classLevel } = req.params;
    
    // Get current academic session
    const sessionResult = await pool.query(
      'SELECT id FROM academic_sessions WHERE is_current = true LIMIT 1'
    );
    
    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'No current academic session found' });
    }
    
    const currentSessionId = sessionResult.rows[0].id;
    
    // Get all classes with this level
    const classesResult = await pool.query(
      `SELECT id, name, stream 
       FROM classes 
       WHERE level = $1 
       AND academic_session_id = $2`,
      [classLevel, currentSessionId]
    );
    
    // If no classes found, create a default empty class to avoid empty response
    if (classesResult.rows.length === 0) {
      classesResult.rows = [{
        id: null,
        name: classLevel,
        stream: 'Default'
      }];
    }
    
    // Get performance by stream
    const streamPerformance = await Promise.all(
      classesResult.rows.map(async (classInfo) => {
        // If the class ID is null (default empty class), return default values
        if (classInfo.id === null) {
          return {
            stream: classInfo.stream,
            className: classInfo.name,
            average: 0,
            studentCount: 0
          };
        }
        
        const streamResult = await pool.query(
          `SELECT 
             ROUND(AVG(srs.average_marks), 2) as average_marks,
             COUNT(DISTINCT srs.student_id) as student_count
           FROM student_result_summary srs
           JOIN examinations e ON srs.examination_id = e.id
           WHERE srs.class_id = $1
           AND e.academic_session_id = $2`,
          [classInfo.id, currentSessionId]
        );
        
        return {
          stream: classInfo.stream,
          className: classInfo.name,
          average: parseFloat(streamResult.rows[0]?.average_marks || 0),
          studentCount: parseInt(streamResult.rows[0]?.student_count || 0)
        };
      })
    );
    
    // First, get all subjects for this curriculum and level
    let allSubjects = await pool.query(
      `SELECT id, name FROM subjects 
       WHERE level = $1 OR level = 'All' 
       ORDER BY name`,
      [classLevel]
    );
    
    // If no subjects found, create empty array to avoid errors
    if (allSubjects.rows.length === 0) {
      allSubjects.rows = [];
    }
    
    // Now get performance data for subjects that have exam results
    const subjectPerformanceData = await pool.query(
      `SELECT 
         s.id as subject_id,
         s.name as subject_name,
         ROUND(AVG(er.marks_obtained), 2) as average_marks
       FROM exam_results er
       JOIN exam_schedules es ON er.exam_schedule_id = es.id
       JOIN subjects s ON es.subject_id = s.id
       JOIN classes c ON es.class_id = c.id
       JOIN examinations e ON es.examination_id = e.id
       WHERE c.level = $1
       AND e.academic_session_id = $2
       GROUP BY s.id, s.name
       ORDER BY average_marks DESC`,
      [classLevel, currentSessionId]
    );
    
    // Merge the data to include all subjects, with zeros for those without data
    const subjectPerformance = {
      rows: allSubjects.rows.map(subject => {
        const performance = subjectPerformanceData.rows.find(p => p.subject_id === subject.id);
        return {
          subject_name: subject.name,
          average_marks: performance ? performance.average_marks : 0
        };
      })
    };
    
    // Get gender performance breakdown
    const genderPerformanceData = await pool.query(
      `SELECT 
         st.gender,
         ROUND(AVG(srs.average_marks), 2) as average_marks,
         COUNT(DISTINCT st.id) as student_count
       FROM student_result_summary srs
       JOIN students st ON srs.student_id = st.id
       JOIN classes c ON srs.class_id = c.id
       JOIN examinations e ON srs.examination_id = e.id
       WHERE c.level = $1
       AND e.academic_session_id = $2
       GROUP BY st.gender`,
      [classLevel, currentSessionId]
    );
    
    // Ensure we have all genders represented, even if no data
    const allGenders = ['male', 'female', 'other'];
    const genderPerformance = {
      rows: allGenders.map(gender => {
        const performance = genderPerformanceData.rows.find(p => p.gender === gender);
        return performance || { 
          gender: gender, 
          average_marks: 0, 
          student_count: 0 
        };
      })
    };
    
    const detailedFormData = {
      classLevel: classLevel,
      streamPerformance,
      subjectPerformance: subjectPerformance.rows.map(subject => ({
        subject: subject.subject_name,
        average: parseFloat(subject.average_marks)
      })),
      genderPerformance: genderPerformance.rows.map(gender => ({
        gender: gender.gender,
        average: parseFloat(gender.average_marks),
        count: parseInt(gender.student_count)
      }))
    };
    
    res.json(detailedFormData);
    
  } catch (error) {
    console.error('Error fetching detailed form performance data:', error);
    res.status(500).json({ error: 'Failed to fetch detailed form performance data' });
  }
});

export default router;
