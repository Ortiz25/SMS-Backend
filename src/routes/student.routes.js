import express from "express";
import { validate } from "../middleware/validate.js";
import { body } from "express-validator";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";
import { createStudentModel } from "../models/studentModel.js";
import pool from "../config/database.js";

const router = express.Router();
const studentModel = createStudentModel();

const studentValidation = [
  body("admission_number").notEmpty().trim(),
  body("first_name").notEmpty().trim(),
  body("last_name").notEmpty().trim(),
  body("date_of_birth").isDate(),
  body("current_class").notEmpty(),
];

router.use(authenticateToken);



router.get('/student/:id', authorizeRoles('admin', 'teacher', 'parent', 'staff', 'student'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;
    
    // Validate required parameters
    if (!id) {
      return res.status(400).json({
        success: false,
        error: "Student ID is required"
      });
    }
    
    // Validate date parameters
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error: "Start date and end date are required"
      });
    }
    
    // Validate student exists
    const studentCheck = await pool.query(
      'SELECT id FROM students WHERE id = $1',
      [id]
    );
    
    if (studentCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Student not found'
      });
    }
    
    // Add authorization check for parents and students
    // (Parents can only view their children's attendance, 
    // students can only view their own attendance)
    if (req.user.role === 'parent') {
      const parentCheck = await pool.query(
        `SELECT 1 FROM student_parent_relationships 
         WHERE parent_id = $1 AND student_id = $2`,
        [req.user.parentId, id]
      );
      
      if (parentCheck.rows.length === 0) {
        return res.status(403).json({
          success: false,
          error: 'You are not authorized to view this student\'s attendance'
        });
      }
    } else if (req.user.role === 'student' && req.user.studentId !== parseInt(id)) {
      return res.status(403).json({
        success: false,
        error: 'You can only view your own attendance'
      });
    }
    
    // Fetch attendance records
    const query = `
      SELECT 
        a.id,
        a.date,
        a.session_type,
        a.status,
        a.reason,
        c.name AS class_name,
        u.username AS recorded_by
      FROM 
        attendance a
      JOIN 
        classes c ON a.class_id = c.id
      JOIN 
        users u ON a.recorded_by = u.id
      WHERE 
        a.student_id = $1
        AND a.date BETWEEN $2 AND $3
      ORDER BY 
        a.date DESC, a.session_type
    `;
    
    const result = await pool.query(query, [id, startDate, endDate]);
    
    // Calculate attendance statistics
    const totalDays = result.rows.length;
    const presentDays = result.rows.filter(row => row.status === 'present').length;
    const absentDays = result.rows.filter(row => row.status === 'absent').length;
    const lateDays = result.rows.filter(row => row.status === 'late').length;
    const leaveDays = result.rows.filter(row => row.status === 'on-leave').length;
    const attendancePercentage = totalDays > 0 ? ((presentDays / totalDays) * 100).toFixed(2) : 0;
    
    // Return the data
    res.json({
      success: true,
      count: result.rows.length,
      statistics: {
        totalDays,
        presentDays,
        absentDays,
        lateDays,
        leaveDays,
        attendancePercentage
      },
      data: result.rows
    });
    
  } catch (error) {
    console.error('Error fetching student attendance:', error);
    next(error);
  }
});

router.get(
  "/detailed",
  authorizeRoles("admin", "teacher", "staff"),
  async (req, res, next) => {
    try {
      // Base query
      const query = `
            SELECT
                s.id,
                s.first_name,
                s.last_name,
                s.other_names,
                s.admission_number AS "admissionNo",
                s.current_class AS class,
                s.stream,
                s.blood_group,
                s.allergies,
                s.admission_date,
                s.medical_conditions,
                s.previous_school,
                INITCAP(s.gender) AS gender,
                TO_CHAR(s.date_of_birth, 'YYYY-MM-DD') AS "dateOfBirth",
                
                -- Attendance Percentage
                (SELECT 
                    ROUND((COUNT(CASE WHEN a.status = 'present' THEN 1 END) * 100.0 / 
                    NULLIF(COUNT(*), 0))::numeric, 0) || '%'
                FROM attendance a 
                WHERE a.student_id = s.id) AS attendance,
                
                -- Latest Performance Grade
                (SELECT er.grade 
                FROM exam_results er
                JOIN exam_schedules es ON er.exam_schedule_id = es.id
                JOIN examinations e ON es.examination_id = e.id
                WHERE er.student_id = s.id
                ORDER BY e.start_date DESC 
                LIMIT 1) AS performance,
                
                s.status,
                s.address,
                s.student_type AS "studentType",
                
                -- Dormitory Info if Boarder
                (SELECT d.name 
                FROM dormitory_allocations da 
                JOIN dormitories d ON da.room_id = d.id 
                WHERE da.student_id = s.id AND da.status = 'active'
                LIMIT 1) AS dormitory,
                
                -- Bus Route if Day Scholar
                (SELECT tr.route_name 
                FROM transport_allocations ta 
                JOIN transport_routes tr ON ta.route_id = tr.id 
                WHERE ta.student_id = s.id AND ta.status = 'active'
                LIMIT 1) AS "busRoute",
                
                -- Guardian Info as JSON
                JSON_BUILD_OBJECT(
                    'name', p.first_name || ' ' || p.last_name,
                    'phone', '+254 ' || SUBSTRING(p.phone_primary, 2),
                    'email', p.email,
                    'relationship', p.relationship  
                ) AS guardian
            FROM 
                students s
          
            LEFT JOIN 
                student_parent_relationships spr ON s.id = spr.student_id AND spr.is_primary_contact = true
            LEFT JOIN 
                parents p ON spr.parent_id = p.id
        `;

      // Add filters if needed
      const { classId, stream, studentType } = req.query;
      let whereClause = "s.status = 'active'";
      const values = [];
      let paramIndex = 1;

      if (classId) {
        whereClause += ` AND c.id = $${paramIndex}`;
        values.push(classId);
        paramIndex++;
      }

      if (stream) {
        whereClause += ` AND s.stream = $${paramIndex}`;
        values.push(stream);
        paramIndex++;
      }

      if (studentType) {
        whereClause += ` AND s.student_type = $${paramIndex}`;
        values.push(studentType);
        paramIndex++;
      }

      // Complete the query
      const finalQuery = `
            ${query}
            WHERE ${whereClause}
            ORDER BY s.admission_number
        `;

      const result = await pool.query(finalQuery, values);

      res.json({
        success: true,
        count: result.rows.length,
        data: result.rows,
      });
    } catch (error) {
      console.error("Error in /detailed endpoint:", error);
      next(error);
    }
  }
);

// Get students for attendance entry
router.get(
  "/by-class",
  authorizeRoles("admin", "teacher", "staff"),
  async (req, res, next) => {
    try {
      const { classId, stream } = req.query;
      console.log(classId, stream);
      
      // Validate required parameters
      if (!classId) {
        return res.status(400).json({
          success: false,
          error: "Class ID is required",
        });
      }
      
      // Get class level from the classId
      const classQuery = "SELECT level, stream FROM classes WHERE id = $1";
      const classResult = await pool.query(classQuery, [classId]);
      
      if (classResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "Class not found",
        });
      }
      
      const classLevel = classResult.rows[0].level;
      
      // Build query with filters
      let query = `
            SELECT
                s.id,
                s.admission_number AS "admissionNo",
                s.first_name || ' ' || s.last_name AS name,
                s.gender,
                s.student_type,
                $1 AS class,
                s.stream
            FROM
                students s
            WHERE
                s.current_class = $2
                AND s.status = 'active'
        `;
      
      let queryParams = [classLevel, classLevel];
      
      // Add stream filter if provided
      if (stream) {
        query += ` AND s.stream = $3`;
        queryParams.push(stream);
      }
      
      // Order by admission number
      query += ` ORDER BY s.admission_number`;
      
      const result = await pool.query(query, queryParams);
      console.log(result);
      
      res.json({
        success: true,
        count: result.rows.length,
        data: result.rows,
      });
    } catch (error) {
      console.error("Error in /by-class endpoint:", error);
      next(error);
    }
  }
);

// Get student by ID
router.get(
  "/:id",
  authorizeRoles("admin", "teacher", "parent"),
  async (req, res, next) => {
    try {
      const result = await studentModel.findById(req.params.id);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Student not found" });
      }
      res.json(result.rows[0]);
    } catch (error) {
      next(error);
    }
  }
);

// Create new student
router.post(
  "/",
  authorizeRoles("admin"),
  validate(studentValidation),
  async (req, res, next) => {
    try {
      const result = await studentModel.create(req.body);
      res.status(201).json(result.rows[0]);
    } catch (error) {
      next(error);
    }
  }
);

// src/routes/student.routes.js - Add or update this route

// Update student with detailed information
router.put('/:id', authorizeRoles('admin', 'teacher'), async (req, res, next) => {
  const client = await pool.connect();
  
  try {
    const { id } = req.params;
    const updateData = req.body;
    
    // Start transaction
    await client.query('BEGIN');
    
    // Validate student exists
    const studentCheck = await client.query(
      'SELECT id, current_class, stream, curriculum_type FROM students WHERE id = $1',
      [id]
    );
    
    if (studentCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Student not found'
      });
    }

    const student = studentCheck.rows[0];
    
    // Extract guardian data if present
    const guardianData = updateData.guardian;
    delete updateData.guardian;
    
    // Extract subjects for special handling
    const subjects = updateData.subjects;
    delete updateData.subjects;
    
    // Remove id from updateData as it's not needed for the update
    delete updateData.id;
    
    // Only proceed if there are fields to update
    if (Object.keys(updateData).length > 0) {
      // Build the dynamic update query
      const setClauses = [];
      const values = [];
      let paramIndex = 1;
      
      for (const [key, value] of Object.entries(updateData)) {
        // Handle arrays (like allergies)
        if (Array.isArray(value)) {
          setClauses.push(`${key} = $${paramIndex}`);
          values.push(value);
        } else {
          setClauses.push(`${key} = $${paramIndex}`);
          values.push(value);
        }
        paramIndex++;
      }
      
      if (setClauses.length > 0) {
        // Add the student ID to values array
        values.push(id);
        
        const updateQuery = `
          UPDATE students
          SET ${setClauses.join(', ')}, updated_at = NOW()
          WHERE id = $${paramIndex}
          RETURNING *
        `;
        
        // Execute the update query
        const result = await client.query(updateQuery, values);
        
        // Update guardian if provided
        if (guardianData && Object.keys(guardianData).length > 0) {
          // Get the guardian ID for this student
          const guardianQuery = `
            SELECT p.id
            FROM parents p
            JOIN student_parent_relationships spr ON p.id = spr.parent_id
            WHERE spr.student_id = $1 AND spr.is_primary_contact = true
          `;
          
          const guardianResult = await client.query(guardianQuery, [id]);
          
          if (guardianResult.rows.length > 0) {
            const guardianId = guardianResult.rows[0].id;
            
            // Build guardian update query
            const guardianSetClauses = [];
            const guardianValues = [];
            let guardianParamIndex = 1;
            
            for (const [key, value] of Object.entries(guardianData)) {
              guardianSetClauses.push(`${key} = $${guardianParamIndex}`);
              guardianValues.push(value);
              guardianParamIndex++;
            }
            
            if (guardianSetClauses.length > 0) {
              // Add the guardian ID to values array
              guardianValues.push(guardianId);
              
              const updateGuardianQuery = `
                UPDATE parents
                SET ${guardianSetClauses.join(', ')}, updated_at = NOW()
                WHERE id = $${guardianParamIndex}
              `;
              
              await client.query(updateGuardianQuery, guardianValues);
            }
          }
        }
      }
    }
    
    // Check if the student_subjects table exists - do this here so it's accessible later
    const tableExistsResult = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'student_subjects'
      );
    `);
    
    const studentSubjectsTableExists = tableExistsResult.rows[0].exists;
    
    // Handle subjects separately (even if no other fields were updated)
    if (subjects && Array.isArray(subjects)) {
      // Get the student's current class and stream (use updated values if provided or original values)
      const currentClass = updateData.current_class || student.current_class;
      const currentStream = updateData.stream || student.stream;
      const curriculumType = updateData.curriculum_type || student.curriculum_type;

      // Get current academic session
      const sessionResult = await client.query(
        'SELECT id FROM academic_sessions WHERE is_current = true LIMIT 1'
      );
      
      if (sessionResult.rows.length === 0) {
        throw new Error('No active academic session found');
      }
      
      const academicSessionId = sessionResult.rows[0].id;
      
      if (studentSubjectsTableExists) {
        // Use student_subjects table for tracking subjects
        
        // Get class information
        const classResult = await client.query(
          `SELECT id FROM classes 
           WHERE level = $1 AND stream = $2 AND academic_session_id = $3`,
          [currentClass, currentStream, academicSessionId]
        );
        
        if (classResult.rows.length === 0) {
          throw new Error(`Class ${currentClass} ${currentStream} not found for the current academic session`);
        }
        
        const classId = classResult.rows[0].id;
        
        // Get existing subjects for this student
        const existingSubjectsResult = await client.query(
          `SELECT ss.id, ss.subject_id, ss.status, s.name 
           FROM student_subjects ss
           JOIN subjects s ON ss.subject_id = s.id
           WHERE ss.student_id = $1 AND ss.academic_session_id = $2`,
          [id, academicSessionId]
        );
        
        // Create a mapping of subject names to IDs for easier lookup
        const subjectNameToIdMap = await getSubjectNameToIdMap(client, curriculumType);
        
        // Convert string-based subjects to IDs if needed
        const subjectIds = subjects.map(subject => {
          // If the subject is already an ID (number or string that can be converted to a number)
          if (!isNaN(subject)) {
            return subject.toString();
          }
          
          // If the subject is a name, look up its ID
          const subjectId = subjectNameToIdMap[subject];
          if (!subjectId) {
            console.warn(`Subject not found: ${subject}`);
          }
          return subjectId;
        }).filter(id => id); // Remove any undefined values
        
        // Get current active subjects
        const currentActiveSubjects = existingSubjectsResult.rows
          .filter(row => row.status === 'active')
          .map(row => row.subject_id.toString());
        
        // Determine subjects to add and remove
        const subjectsToAdd = subjectIds.filter(id => !currentActiveSubjects.includes(id));
        const subjectsToRemove = currentActiveSubjects.filter(id => !subjectIds.includes(id));
        
        // Map of subject IDs to existing enrollment records
        const subjectToEnrollmentMap = {};
        existingSubjectsResult.rows.forEach(row => {
          subjectToEnrollmentMap[row.subject_id] = row;
        });
        
        // Process subjects to add
        for (const subjectId of subjectsToAdd) {
          // Get teacher for this subject and class
          const teacherResult = await client.query(
            `SELECT teacher_id FROM teacher_subjects 
             WHERE subject_id = $1 AND class_id = $2 AND academic_session_id = $3`,
            [subjectId, classId, academicSessionId]
          );
          
          const teacherId = teacherResult.rows.length > 0 ? teacherResult.rows[0].teacher_id : null;
          
          // Check if there's an existing enrollment we can reactivate
          const existingEnrollment = subjectToEnrollmentMap[subjectId];
          
          if (existingEnrollment) {
            // Reactivate existing enrollment
            await client.query(
              `UPDATE student_subjects 
               SET status = 'active', updated_at = NOW() 
               WHERE id = $1`,
              [existingEnrollment.id]
            );
          } else {
            // Create new enrollment
            await client.query(
              `INSERT INTO student_subjects
               (student_id, subject_id, class_id, academic_session_id, teacher_id, enrollment_date)
               VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)`,
              [id, subjectId, classId, academicSessionId, teacherId]
            );
          }
        }
        
        // Process subjects to remove
        for (const subjectId of subjectsToRemove) {
          await client.query(
            `UPDATE student_subjects 
             SET status = 'dropped', updated_at = NOW() 
             WHERE student_id = $1 AND subject_id = $2 AND academic_session_id = $3 AND status = 'active'`,
            [id, subjectId, academicSessionId]
          );
        }
      } else {
        // If we don't have the student_subjects table, store the subjects as a JSON array
        // in a field called "subjects" in the students table
        await client.query(
          `UPDATE students SET subjects = $1 WHERE id = $2`,
          [subjects, id]
        );
      }
    }
    
    // Commit the transaction
    await client.query('COMMIT');
    
    // Get the updated student data with guardian info and subjects
    const updatedStudentQuery = `
      SELECT s.*, 
             p.first_name || ' ' || p.last_name AS guardian_name,
             p.relationship AS guardian_relationship,
             p.phone_primary AS guardian_phone,
             p.email AS guardian_email,
             p.id_number AS guardian_id_number
      FROM students s
      LEFT JOIN student_parent_relationships spr ON s.id = spr.student_id AND spr.is_primary_contact = true
      LEFT JOIN parents p ON spr.parent_id = p.id
      WHERE s.id = $1
    `;
    
    const updatedStudent = await pool.query(updatedStudentQuery, [id]);
    
    // If we're using the student_subjects table, get the current subjects
    if (studentSubjectsTableExists) {
      const currentSubjectsQuery = `
        SELECT s.id AS subject_id, s.name AS subject_name, s.code AS subject_code
        FROM student_subjects ss
        JOIN subjects s ON ss.subject_id = s.id
        WHERE ss.student_id = $1 
        AND ss.academic_session_id = $2
        AND ss.status = 'active'
        ORDER BY s.name
      `;
      
      const sessionResult = await pool.query(
        'SELECT id FROM academic_sessions WHERE is_current = true LIMIT 1'
      );
      
      if (sessionResult.rows.length > 0) {
        const academicSessionId = sessionResult.rows[0].id;
        const subjectsResult = await pool.query(currentSubjectsQuery, [id, academicSessionId]);
        
        // Add subjects to the response
        if (updatedStudent.rows.length > 0) {
          updatedStudent.rows[0].subjects = subjectsResult.rows.map(row => row.subject_id.toString());
          updatedStudent.rows[0].subject_names = subjectsResult.rows.map(row => row.subject_name);
        }
      }
    }
    
    return res.json({
      success: true,
      message: 'Student updated successfully',
      data: updatedStudent.rows[0]
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating student:', error);
    
    return res.status(500).json({
      success: false,
      error: 'Failed to update student',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});
/**
 * Helper function to get a mapping of subject names to IDs
 * @param {Object} client - Database client
 * @param {String} curriculumType - Curriculum type (CBC or 844)
 * @returns {Object} Map of subject names to IDs
 */
async function getSubjectNameToIdMap(client, curriculumType) {
  const subjectsResult = await client.query(
    `SELECT id, name FROM subjects WHERE curriculum_type = $1`,
    [curriculumType]
  );
  
  const map = {};
  subjectsResult.rows.forEach(row => {
    map[row.name] = row.id.toString();
  });
  
  return map;
}


// Delete student
router.delete("/:id", authorizeRoles("admin"), async (req, res, next) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const studentId = req.params.id;

    // First verify student exists
    const checkQuery = `SELECT id, admission_number FROM students WHERE id = $1`;
    const checkResult = await client.query(checkQuery, [studentId]);

    if (checkResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        success: false,
        error: "Student not found",
      });
    }

    const student = checkResult.rows[0];

    // 1. Delete attendance records
    await client.query(
      `
            DELETE FROM attendance 
            WHERE student_id = $1
        `,
      [studentId]
    );

    // 2. Delete academic records
    await client.query(
      `
            DELETE FROM academic_records 
            WHERE student_id = $1
        `,
      [studentId]
    );

    // 3. Delete hostel allocations
    await client.query(
      `
            DELETE FROM hostel_allocations 
            WHERE student_id = $1
        `,
      [studentId]
    );

    // 4. Delete transport allocations
    await client.query(
      `
            DELETE FROM transport_allocations 
            WHERE student_id = $1
        `,
      [studentId]
    );

    // 5. Delete fee payments
    await client.query(
      `
            DELETE FROM fee_payments 
            WHERE student_id = $1
        `,
      [studentId]
    );

    // 6. Delete book borrowings
    await client.query(
      `
            DELETE FROM book_borrowing 
            WHERE student_id = $1
        `,
      [studentId]
    );

    // 7. Get parent relationships
    const parentQuery = `
            SELECT parent_id 
            FROM student_parent_relationships 
            WHERE student_id = $1
        `;
    const parentResult = await client.query(parentQuery, [studentId]);
    const parentIds = parentResult.rows.map((row) => row.parent_id);

    // 8. Delete student-parent relationships
    await client.query(
      `
            DELETE FROM student_parent_relationships 
            WHERE student_id = $1
        `,
      [studentId]
    );

    // 9. Delete parents if they have no other children
    if (parentIds.length > 0) {
      for (const parentId of parentIds) {
        const otherChildrenQuery = `
                    SELECT COUNT(*) 
                    FROM student_parent_relationships 
                    WHERE parent_id = $1
                `;
        const otherChildrenResult = await client.query(otherChildrenQuery, [
          parentId,
        ]);

        if (parseInt(otherChildrenResult.rows[0].count) === 0) {
          // This parent has no other children, so we can delete them
          await client.query(
            `
                        DELETE FROM parents 
                        WHERE id = $1
                    `,
            [parentId]
          );
        }
      }
    }

    // 10. Finally delete the student
    await client.query(
      `
            DELETE FROM students 
            WHERE id = $1
        `,
      [studentId]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: `Student ${student.admission_number} deleted successfully`,
      data: {
        id: studentId,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error deleting student:", error);
    next(error);
  } finally {
    client.release();
  }
});

// Get student attendance
router.get(
  "/:id/attendance",
  authorizeRoles("admin", "teacher", "parent"),
  async (req, res, next) => {
    try {
      const { start_date, end_date } = req.query;
      const result = await studentModel.getAttendanceReport(
        req.params.id,
        new Date(start_date),
        new Date(end_date)
      );
      res.json(result.rows);
    } catch (error) {
      next(error);
    }
  }
);

// src/routes/student.routes.js - Modified add student route

router.post("/add", authorizeRoles("admin"), async (req, res, next) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const {
      // Personal Information
      firstName,
      lastName,
      otherNames,
      admissionNo,
      class: className,
      stream,
      dateOfBirth,
      gender,

      // Student Type and Related Info
      studentType,
      address,
      busRoute,
      hostel,

      // Medical Information
      medicalInfo,

      // Guardian Information
      guardianFirstName,
      guardianLastName,
      guardianPhone,
      guardianEmail,
      guardianRelation,
      guardianAddress,
    } = req.body;

    // Determine curriculum type based on class
    let curriculumType = "CBC";
    if (className && className.toString().toLowerCase().includes("form")) {
      curriculumType = "844";
    }

    // Parse allergies if provided
    let allergiesArray = [];
    if (medicalInfo) {
      // Simple logic to extract allergies from medical info - can be enhanced
      const allergiesMatch = medicalInfo.match(/allergies?:?\s*([^\.]+)/i);
      if (allergiesMatch && allergiesMatch[1]) {
        allergiesArray = allergiesMatch[1]
          .split(",")
          .map((item) => item.trim());
      }
    }

    // 1. Create student record with all required fields
    const studentQuery = `
            INSERT INTO students (
                admission_number, first_name, last_name, other_names, 
                date_of_birth, gender, address, admission_date,
                curriculum_type, current_class, stream,
                allergies,
                emergency_contact_name, emergency_contact_phone,
                student_type, status, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, CURRENT_TIMESTAMP)
            RETURNING id
        `;

    const studentParams = [
      admissionNo,
      firstName,
      lastName,
      otherNames,
      dateOfBirth,
      gender.toLowerCase(),
      address,
      new Date(), // admission_date is today
      curriculumType,
      className,
      stream,
      allergiesArray,
      `${guardianFirstName} ${guardianLastName}`, // Using guardian info for emergency contact by default
      guardianPhone,
      studentType === "Boarder" ? "boarder" : "day_scholar",
      "active",
    ];

    const studentResult = await client.query(studentQuery, studentParams);
    const studentId = studentResult.rows[0].id;

    // 2. Create parent/guardian record
    const guardianQuery = `
            INSERT INTO parents (
                first_name, last_name, relationship, email, 
                phone_primary, address, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
            RETURNING id
        `;

    const guardianParams = [
      guardianFirstName,
      guardianLastName,
      guardianRelation,
      guardianEmail || null,
      guardianPhone,
      guardianAddress, // Using same address as student for now
    ];

    const guardianResult = await client.query(guardianQuery, guardianParams);
    const guardianId = guardianResult.rows[0].id;

    // 3. Create student-parent relationship
    const relationshipQuery = `
            INSERT INTO student_parent_relationships (
                student_id, parent_id, is_primary_contact, created_at
            ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        `;

    const relationshipParams = [
      studentId,
      guardianId,
      true, // Primary contact
    ];

    await client.query(relationshipQuery, relationshipParams);

    // 4. If boarder, create dormitory allocation
    if (studentType === "Boarder" && hostel) {
      // Find current academic session
      const sessionQuery = `SELECT id FROM academic_sessions WHERE is_current = true LIMIT 1`;
      const sessionResult = await client.query(sessionQuery);
      const academicSessionId = sessionResult.rows[0]?.id;

      if (academicSessionId) {
        // Get dormitory id from name
        const dormQuery = `SELECT id FROM dormitories WHERE name = $1 LIMIT 1`;
        const dormResult = await client.query(dormQuery, [hostel]);
        const dormitoryId = dormResult.rows[0]?.id;

        if (dormitoryId) {
          // First get an available room in this dormitory
          const roomQuery = `
            SELECT dr.id AS room_id 
            FROM dormitory_rooms dr 
            WHERE dr.dormitory_id = $1 
            AND dr.occupied < dr.capacity 
            LIMIT 1
          `;
          const roomResult = await client.query(roomQuery, [dormitoryId]);
          const roomId = roomResult.rows[0]?.room_id;

          if (roomId) {
            // Find an available bed number
            // This is simplified - you might need a more sophisticated bed assignment system
            const bedQuery = `
              SELECT MAX(CAST(bed_number AS INTEGER)) as max_bed
              FROM dormitory_allocations
              WHERE room_id = $1
            `;
            const bedResult = await client.query(bedQuery, [roomId]);
            const nextBed = (bedResult.rows[0]?.max_bed || 0) + 1;

            const dormAllocationQuery = `
              INSERT INTO dormitory_allocations (
                student_id, room_id, bed_number, academic_session_id, 
                allocation_date, status, created_at
              ) VALUES ($1, $2, $3, $4, CURRENT_DATE, 'active', CURRENT_TIMESTAMP)
            `;

            await client.query(dormAllocationQuery, [
              studentId,
              roomId,
              nextBed.toString(),
              academicSessionId
            ]);
          }
        }
      }
    }

    // 5. If day scholar, create transport allocation
    if (studentType === "Day Scholar" && busRoute && busRoute !== "None") {
      // Find current academic session
      const sessionQuery = `SELECT id FROM academic_sessions WHERE is_current = true LIMIT 1`;
      const sessionResult = await client.query(sessionQuery);
      const academicSessionId = sessionResult.rows[0]?.id;

      if (academicSessionId) {
        // Get a pickup stop for the route (first one as default)
        const stopQuery = `
          SELECT id FROM route_stops 
          WHERE route_id = $1 
          ORDER BY stop_order ASC 
          LIMIT 1
        `;
        const stopResult = await client.query(stopQuery, [busRoute]);
        const pickupStopId = stopResult.rows[0]?.id;

        const transportAllocationQuery = `
          INSERT INTO transport_allocations (
            student_id, route_id, pickup_stop_id, academic_session_id, 
            allocation_date, status, created_at
          ) VALUES ($1, $2, $3, $4, CURRENT_DATE, 'active', CURRENT_TIMESTAMP)
        `;

        await client.query(transportAllocationQuery, [
          studentId,
          busRoute,
          pickupStopId,
          academicSessionId
        ]);
      }
    }

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Student added successfully",
      data: {
        id: studentId,
        admissionNo,
        name: `${firstName} ${lastName}`,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error adding student:", error);

    // Provide more specific error messages
    if (error.code === "23505") {
      // Unique violation
      if (error.constraint === "students_admission_number_key") {
        return res.status(400).json({
          success: false,
          error: "Admission number already exists",
        });
      } else if (error.constraint === "students_nemis_upi_key") {
        return res.status(400).json({
          success: false,
          error: "NEMIS UPI already exists",
        });
      }
    }

    next(error);
  } finally {
    client.release();
  }
});

router.get('/:studentId/subjects', authorizeRoles("admin"), async (req, res) => {
  try {
    const { studentId } = req.params;
    const { academicSessionId } = req.query;

    // Check if user has permission to access this student's data
    const hasAccess = await checkUserAccess(req.user.id, req.user.role, studentId);
    
    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to access this student\'s subjects'
      });
    }

    // Get the current academic session if not specified
    let currentSessionId = academicSessionId;
    if (!currentSessionId) {
      const sessionQuery = `
        SELECT id FROM academic_sessions WHERE is_current = true LIMIT 1
      `;
      const sessionResult = await pool.query(sessionQuery);
      if (sessionResult.rows.length > 0) {
        currentSessionId = sessionResult.rows[0].id;
      }
    }

    // Get the student's class and stream for filtering
    const studentQuery = `
      SELECT 
        id, 
        first_name, 
        last_name, 
        admission_number, 
        current_class, 
        stream,
        curriculum_type 
      FROM students 
      WHERE id = $1
    `;
    const studentResult = await pool.query(studentQuery, [studentId]);
    
    if (studentResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Student not found'
      });
    }

    const student = studentResult.rows[0];

    // Get subjects from exam_results (for existing schema)
    const examSubjectsQuery = `
      SELECT DISTINCT 
        sub.id as subject_id,
        sub.name as subject_name,
        sub.code as subject_code,
        t.first_name || ' ' || t.last_name as teacher_name,
        t.id as teacher_id,
        c.level as class_level,
        c.stream as class_stream,
        acs.year as academic_year,
        acs.term as academic_term,
        'active' as status,
        NOW() as enrollment_date
      FROM 
        exam_results er
      JOIN 
        exam_schedules es ON er.exam_schedule_id = es.id
      JOIN 
        subjects sub ON es.subject_id = sub.id
      JOIN 
        examinations e ON es.examination_id = e.id
      JOIN 
        classes c ON es.class_id = c.id
      LEFT JOIN 
        teacher_subjects ts ON ts.subject_id = sub.id AND ts.class_id = c.id
      LEFT JOIN 
        teachers t ON ts.teacher_id = t.id
      JOIN 
        academic_sessions acs ON e.academic_session_id = acs.id
      WHERE 
        er.student_id = $1
        AND acs.id = $2
      ORDER BY 
        sub.name
    `;

    // Alternatively, get subjects based on class and curriculum type
    const classSubjectsQuery = `
      SELECT DISTINCT
        sub.id as subject_id,
        sub.name as subject_name,
        sub.code as subject_code,
        t.first_name || ' ' || t.last_name as teacher_name,
        t.id as teacher_id,
        c.level as class_level,
        c.stream as class_stream,
        acs.year as academic_year,
        acs.term as academic_term,
        'active' as status,
        NOW() as enrollment_date
      FROM 
        subjects sub
      JOIN 
        teacher_subjects ts ON sub.id = ts.subject_id
      JOIN 
        classes c ON ts.class_id = c.id AND c.level = $1 AND c.stream = $2
      JOIN 
        teachers t ON ts.teacher_id = t.id
      JOIN 
        academic_sessions acs ON ts.academic_session_id = acs.id
      WHERE 
        sub.curriculum_type = $3
        AND acs.id = $4
      ORDER BY 
        sub.name
    `;

    // Try to get subjects from exam_results first
    let result = await pool.query(examSubjectsQuery, [studentId, currentSessionId]);
    
    // If no results found, try the class-based approach
    if (result.rows.length === 0) {
      result = await pool.query(classSubjectsQuery, [
        student.current_class, 
        student.stream, 
        student.curriculum_type, 
        currentSessionId
      ]);
    }

    return res.status(200).json({
      success: true,
      student: student,
      data: result.rows,
      count: result.rows.length
    });
    
  } catch (error) {
    console.error('Error fetching student subjects:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error while fetching student subjects',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

router.post('/:studentId/subjects', authorizeRoles("admin"), async (req, res) => {
  // Start a transaction
  const client = await pool.connect();
  
  try {
    const { studentId } = req.params;
    const { add = [], remove = [], academic_session_id } = req.body;
    
    // Only admin and teachers can modify student subjects
    if (req.user.role !== 'admin' && req.user.role !== 'teacher') {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to modify student subjects'
      });
    }
    
    await client.query('BEGIN');
    
    // Get the current academic session if not specified
    let currentSessionId = academic_session_id;
    if (!currentSessionId) {
      const sessionQuery = `
        SELECT id FROM academic_sessions WHERE is_current = true LIMIT 1
      `;
      const sessionResult = await client.query(sessionQuery);
      if (sessionResult.rows.length > 0) {
        currentSessionId = sessionResult.rows[0].id;
      } else {
        throw new Error('No active academic session found');
      }
    }
    
    // Get the student's current class
    const studentQuery = `
      SELECT id, current_class, stream, curriculum_type 
      FROM students 
      WHERE id = $1
    `;
    const studentResult = await client.query(studentQuery, [studentId]);
    
    if (studentResult.rows.length === 0) {
      throw new Error('Student not found');
    }
    
    const student = studentResult.rows[0];
    
    // Get the class ID
    const classQuery = `
      SELECT id 
      FROM classes 
      WHERE level = $1 
      AND stream = $2 
      AND academic_session_id = $3
    `;
    const classResult = await client.query(classQuery, [
      student.current_class, 
      student.stream, 
      currentSessionId
    ]);
    
    if (classResult.rows.length === 0) {
      throw new Error(`Class ${student.current_class} ${student.stream} not found for the selected academic session`);
    }
    
    const classId = classResult.rows[0].id;
    
    // First, check if we need to create the student_subjects table
    const tableExistsQuery = `
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'student_subjects'
      );
    `;
    
    const tableExists = await client.query(tableExistsQuery);
    
    if (!tableExists.rows[0].exists) {
      // Create the student_subjects table if it doesn't exist
      const createTableQuery = `
        CREATE TABLE student_subjects (
          id SERIAL PRIMARY KEY,
          student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
          class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
          academic_session_id INTEGER NOT NULL REFERENCES academic_sessions(id) ON DELETE CASCADE,
          teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
          enrollment_date DATE NOT NULL DEFAULT CURRENT_DATE,
          is_elective BOOLEAN DEFAULT FALSE,
          status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'dropped', 'completed')),
          final_grade VARCHAR(2),
          comments TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(student_id, subject_id, academic_session_id)
        );
        
        CREATE INDEX idx_student_subjects_student_id ON student_subjects(student_id);
        CREATE INDEX idx_student_subjects_subject_id ON student_subjects(subject_id);
        CREATE INDEX idx_student_subjects_academic_session ON student_subjects(academic_session_id);
      `;
      
      await client.query(createTableQuery);
    }
    
    // Process subjects to add
    if (add && add.length > 0) {
      for (const subjectId of add) {
        try {
          // Get teacher assigned to this subject for this class
          const teacherQuery = `
            SELECT teacher_id 
            FROM teacher_subjects 
            WHERE subject_id = $1 
            AND class_id = $2 
            AND academic_session_id = $3
          `;
          
          const teacherResult = await client.query(teacherQuery, [subjectId, classId, currentSessionId]);
          const teacherId = teacherResult.rows.length > 0 ? teacherResult.rows[0].teacher_id : null;
          
          // Check if the student is already enrolled in this subject
          const checkQuery = `
            SELECT id, status 
            FROM student_subjects 
            WHERE student_id = $1 
            AND subject_id = $2 
            AND academic_session_id = $3
          `;
          
          const checkResult = await client.query(checkQuery, [studentId, subjectId, currentSessionId]);
          
          if (checkResult.rows.length > 0) {
            // If already exists but dropped, reactivate it
            if (checkResult.rows[0].status === 'dropped') {
              await client.query(
                `UPDATE student_subjects 
                 SET status = 'active', updated_at = NOW() 
                 WHERE id = $1`,
                [checkResult.rows[0].id]
              );
            }
            // Otherwise it's already active, skip
          } else {
            // Insert new subject enrollment
            await client.query(
              `INSERT INTO student_subjects 
               (student_id, subject_id, class_id, academic_session_id, teacher_id) 
               VALUES ($1, $2, $3, $4, $5)`,
              [studentId, subjectId, classId, currentSessionId, teacherId]
            );
          }
        } catch (error) {
          console.error(`Error adding subject ${subjectId}:`, error);
          // Continue with next subject instead of failing completely
        }
      }
    }
    
    // Process subjects to remove
    if (remove && remove.length > 0) {
      for (const subjectId of remove) {
        try {
          // Mark as dropped instead of deleting
          await client.query(
            `UPDATE student_subjects 
             SET status = 'dropped', updated_at = NOW() 
             WHERE student_id = $1 
             AND subject_id = $2 
             AND academic_session_id = $3 
             AND status = 'active'`,
            [studentId, subjectId, currentSessionId]
          );
        } catch (error) {
          console.error(`Error removing subject ${subjectId}:`, error);
          // Continue with next subject instead of failing completely
        }
      }
    }
    
    await client.query('COMMIT');
    
    // Get the updated subjects
    const updatedSubjectsQuery = `
      SELECT 
        ss.id as enrollment_id,
        ss.subject_id,
        s.name as subject_name,
        s.code as subject_code,
        t.first_name || ' ' || t.last_name as teacher_name,
        t.id as teacher_id,
        ss.is_elective,
        ss.status,
        ss.enrollment_date,
        c.level as class_level,
        c.stream as class_stream
      FROM 
        student_subjects ss
      JOIN 
        subjects s ON ss.subject_id = s.id
      LEFT JOIN 
        teachers t ON ss.teacher_id = t.id
      JOIN 
        classes c ON ss.class_id = c.id
      WHERE 
        ss.student_id = $1
        AND ss.academic_session_id = $2
        AND ss.status = 'active'
      ORDER BY 
        s.name
    `;
    
    const updatedSubjects = await pool.query(updatedSubjectsQuery, [studentId, currentSessionId]);
    
    return res.status(200).json({
      success: true,
      message: 'Student subjects updated successfully',
      data: updatedSubjects.rows,
      count: updatedSubjects.rows.length
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating student subjects:', error);
    
    return res.status(500).json({
      success: false,
      message: 'Error updating student subjects',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  } finally {
    client.release();
  }
});


export default router;
