import express from "express";
import { validate } from "../middleware/validate.js";
import { body } from "express-validator";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";
import { createStudentModel } from "../models/studentModel.js";
import pool from "../config/database.js";
import { CLIENT_RENEG_LIMIT } from "tls";

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
      // Base query - modified to use a subquery approach instead of template literals
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
            s.curriculum_type,
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
            JOIN dormitory_rooms dr ON da.room_id = dr.id
            JOIN dormitories d ON dr.dormitory_id = d.id
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
            ) AS guardian,
            
            -- Add subjects as JSON array
            COALESCE(
                (
                    SELECT JSON_AGG(
                        JSON_BUILD_OBJECT(
                            'id', sub.id,
                            'name', sub.name,
                            'code', sub.code,
                            'teacher', COALESCE(t.first_name || ' ' || t.last_name, 'Not Assigned'),
                            'status', ss.status,
                            'isElective', ss.is_elective
                        )
                    )
                    FROM student_subjects ss
                    JOIN subjects sub ON ss.subject_id = sub.id
                    LEFT JOIN teachers t ON ss.teacher_id = t.id
                    WHERE ss.student_id = s.id 
                    AND ss.status = 'active'
                    -- Get the latest academic session for each student
                    AND ss.academic_session_id = (
                        SELECT ss2.academic_session_id
                        FROM student_subjects ss2
                        JOIN academic_sessions ac ON ss2.academic_session_id = ac.id
                        WHERE ss2.student_id = s.id
                        ORDER BY ac.year DESC, ac.term DESC
                        LIMIT 1
                    )
                ),
                '[]'::json
            ) AS subjects
        FROM
            students s
     
        LEFT JOIN
            student_parent_relationships spr ON s.id = spr.student_id AND spr.is_primary_contact = true
        LEFT JOIN
            parents p ON spr.parent_id = p.id
      `;

      // Add filters if needed
      const { classId, stream, studentType, status } = req.query;
      let whereClause = "1=1"; // Changed from "s.status = 'active'" to "1=1" to include all statuses
      const values = [];
      let paramIndex = 1;
      
      // Add optional status filter
      if (status) {
        whereClause += ` AND s.status = $${paramIndex}`;
        values.push(status);
        paramIndex++;
      }
      
      if (classId) {
        whereClause += ` AND s.current_class = (SELECT level FROM classes WHERE id = $${paramIndex})`;
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




// Update student route handler with fixed schema references
// Add this helper function at the top of your file
function mapClassToLevel(className, curriculumType) {
  // For CBC curriculum
  if (curriculumType === 'CBC') {
    // Map specific grades to their corresponding levels
    if (/^Grade [1-3]\b/.test(className)) {
      return 'Lower Primary';
    } else if (/^Grade [4-6]\b/.test(className)) {
      return 'Upper Primary';
    } else if (/^Grade [7-9]\b/.test(className)) {
      return 'Junior Secondary';
    } else if (/^Grade 1[0-2]\b/.test(className)) {
      return 'Senior Secondary';
    }
  } 
  // For 844 curriculum
  else if (curriculumType === '844') {
    if (/^Form [1-4]\b/.test(className)) {
      return 'Secondary';
    }
  }
  
  // Default return the original class if no mapping found
  return className;
}

router.put('/:id', authorizeRoles("admin"), async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const updateData = req.body;
    
    console.log('Update request for student ID:', id);
    console.log('Update data received:', updateData);
    
    // Check if student exists
    const studentCheck = await client.query('SELECT * FROM students WHERE id = $1', [id]);
    
    if (studentCheck.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Student not found'
      });
    }

    // Store the original student data
    let updatedStudent = studentCheck.rows[0];
    
    // Extract guardian data if present
    const guardianData = updateData.guardian;
    delete updateData.guardian;
    
    // Extract subjects for special handling
    let subjects = updateData.subjects;
    delete updateData.subjects;
    
    // Remove duplicates from subjects array if it exists
    if (subjects && Array.isArray(subjects)) {
      console.log('Subject data received:', subjects);
    }
    
    // Remove id from updateData as it's not needed for the update
    delete updateData.id;
    
    // Check for invalid column names and correct them
    // Fix the "conditions" to "medical_conditions" issue
    if (updateData.conditions !== undefined) {
      console.log('Converting "conditions" to "medical_conditions"');
      updateData.medical_conditions = updateData.conditions;
      delete updateData.conditions;
    }
    
    // Log the request data after preprocessing
    console.log('Preprocessed update data:', updateData);
    
    // Only proceed if there are fields to update
    if (Object.keys(updateData).length > 0) {
      // Build the dynamic update query
      const setClauses = [];
      const values = [];
      let paramIndex = 1;
      
      for (const [key, value] of Object.entries(updateData)) {
        // Skip fields that don't exist in the table
        if (!isValidStudentColumn(key)) {
          console.warn(`Skipping invalid column: ${key}`);
          continue;
        }
        
        console.log(`Processing field for update: ${key} = `, value);
        
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
      
      // Only proceed if we have set clauses
      if (setClauses.length > 0) {
        // Add the student ID to values array
        values.push(id);
        
        console.log('Update query SET clauses:', setClauses.join(', '));
        console.log('Update query values:', values);
        
        const updateQuery = `
          UPDATE students
          SET ${setClauses.join(', ')}, updated_at = NOW()
          WHERE id = $${paramIndex}
          RETURNING *
        `;
        
        // Execute the update query
        try {
          const result = await client.query(updateQuery, values);
          if (result.rows.length > 0) {
            updatedStudent = result.rows[0];
            console.log('Student updated successfully');
          } else {
            console.error('Update query returned no rows');
            // We already have the original student data in updatedStudent, no need to reassign
          }
        } catch (queryError) {
          console.error('Error executing update query:', queryError);
          throw queryError; // Rethrow to be caught by the outer try/catch
        }
      }
      
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
          
          // Map from frontend field names to database column names
          const guardianFieldMapping = {
            name: ['first_name', 'last_name'], // Special case for name that needs to be split
            relationship: 'relationship',
            phone: 'phone_primary',
            email: 'email',
            idNumber: 'id_number'
          };
          
          for (const [key, value] of Object.entries(guardianData)) {
            // Handle special case for name field (needs to be split into first_name and last_name)
            if (key === 'name' && value) {
              const nameParts = value.split(' ');
              const firstName = nameParts[0];
              const lastName = nameParts.slice(1).join(' ') || '';
              
              guardianSetClauses.push(`first_name = $${guardianParamIndex}`);
              guardianValues.push(firstName);
              guardianParamIndex++;
              
              guardianSetClauses.push(`last_name = $${guardianParamIndex}`);
              guardianValues.push(lastName);
              guardianParamIndex++;
            } else if (guardianFieldMapping[key]) {
              // Regular case - direct field mapping
              const dbField = guardianFieldMapping[key];
              guardianSetClauses.push(`${dbField} = $${guardianParamIndex}`);
              guardianValues.push(value);
              guardianParamIndex++;
            }
          }
          
          if (guardianSetClauses.length > 0) {
            // Add the guardian ID to values array
            guardianValues.push(guardianId);
            
            const updateGuardianQuery = `
              UPDATE parents
              SET ${guardianSetClauses.join(', ')}, updated_at = NOW()
              WHERE id = $${guardianParamIndex}
            `;
            
            console.log('Guardian update query:', updateGuardianQuery);
            console.log('Guardian update values:', guardianValues);
            
            await client.query(updateGuardianQuery, guardianValues);
          }
        }
      }
    }
    
    // Check if we have current class and stream from the student data
    // If updatedStudent somehow doesn't have current_class or stream, fetch it again
    if (!updatedStudent.current_class || !updatedStudent.stream) {
      console.log('Missing class or stream information, fetching complete student data');
      const refreshedStudentResult = await client.query('SELECT * FROM students WHERE id = $1', [id]);
      if (refreshedStudentResult.rows.length > 0) {
        updatedStudent = refreshedStudentResult.rows[0];
      }
    }
    
    console.log('Student data for subject update:', {
      id: updatedStudent.id,
      current_class: updatedStudent.current_class,
      stream: updatedStudent.stream,
      curriculum_type: updatedStudent.curriculum_type
    });
    
    // Handle subjects update if provided
    if (subjects && Array.isArray(subjects) && updatedStudent.current_class && updatedStudent.stream) {
      console.log('Updating subjects for student:', id);
      
      // Extract just the subject IDs from the subjects array, handling all possible formats
      const subjectIds = [];
      
      subjects.forEach(subject => {
        if (typeof subject === 'object' && subject !== null && subject.id) {
          // Handle object format: { id: 123, name: "Math", ... }
          const numId = parseInt(subject.id);
          if (!isNaN(numId)) {
            subjectIds.push(numId);
          }
        } else if (typeof subject === 'string' || typeof subject === 'number') {
          // Handle string/number format: "123" or 123
          const numId = parseInt(subject);
          if (!isNaN(numId)) {
            subjectIds.push(numId);
          }
        }
      });
      
      // Remove duplicates
      const uniqueSubjectIds = [...new Set(subjectIds)];
      
      console.log('Processed unique subject IDs:', uniqueSubjectIds);
      
      // Get latest academic session for subject management
      const sessionResult = await client.query(
        'SELECT id FROM academic_sessions ORDER BY year DESC, term DESC LIMIT 1'
      );
      
      if (sessionResult.rows.length > 0) {
        const academicSessionId = sessionResult.rows[0].id;
        console.log('Using latest academic session ID:', academicSessionId);
        
        // Get student's current class in this session
        const classResult = await client.query(
          `SELECT id FROM classes 
           WHERE level = $1 AND stream = $2 AND academic_session_id = $3 
           LIMIT 1`,
          [updatedStudent.current_class, updatedStudent.stream, academicSessionId]
        );
        
        // If class doesn't exist in this session, try to find or create it
        let classId;
        if (classResult.rows.length > 0) {
          classId = classResult.rows[0].id;
        } else {
          console.log('Class not found in current session, checking for class definition');
          
          // Try to find a class definition from any session to use as a template
          const classTemplateResult = await client.query(
            `SELECT * FROM classes 
             WHERE level = $1 AND stream = $2
             LIMIT 1`,
            [updatedStudent.current_class, updatedStudent.stream]
          );
          
          if (classTemplateResult.rows.length > 0) {
            const classTemplate = classTemplateResult.rows[0];
            console.log('Found class template, creating class for current session');
            
            // Create the class for the current session
            const createClassResult = await client.query(
              `INSERT INTO classes 
               (name, curriculum_type, level, stream, class_teacher_id, academic_session_id, capacity)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               RETURNING id`,
              [
                classTemplate.name,
                updatedStudent.curriculum_type, // Use student's curriculum type
                updatedStudent.current_class,
                updatedStudent.stream,
                classTemplate.class_teacher_id,
                academicSessionId,
                classTemplate.capacity || 40 // Default capacity if not specified
              ]
            );
            
            if (createClassResult.rows.length > 0) {
              classId = createClassResult.rows[0].id;
              console.log('Created new class with ID:', classId);
            } else {
              console.error('Failed to create class for current session');
            }
          } else {
            console.warn('No class template found, cannot create class');
          }
        }
        
        if (classId) {
          // Get currently enrolled subjects
          const currentSubjectsResult = await client.query(
            `SELECT subject_id FROM student_subjects 
             WHERE student_id = $1 AND academic_session_id = $2 AND status = $3`,
            [id, academicSessionId, 'active']
          );
          
          const currentSubjectIds = currentSubjectsResult.rows.map(row => parseInt(row.subject_id));
          console.log('Current active subjects:', currentSubjectIds);
          
          // Determine which subjects to add and which to remove
          const subjectsToAdd = uniqueSubjectIds.filter(subjectId => !currentSubjectIds.includes(subjectId));
          const subjectsToRemove = currentSubjectIds.filter(subjectId => !uniqueSubjectIds.includes(subjectId));
          
          console.log('Subjects to add:', subjectsToAdd);
          console.log('Subjects to remove:', subjectsToRemove);
          
          // Mark subjects as dropped if they're no longer selected
          if (subjectsToRemove.length > 0) {
            try {
              const dropResult = await client.query(
                `UPDATE student_subjects 
                 SET status = $1, updated_at = NOW() 
                 WHERE student_id = $2 AND subject_id = ANY($3) AND academic_session_id = $4`,
                ['dropped', id, subjectsToRemove, academicSessionId]
              );
              console.log(`Marked ${dropResult.rowCount} subjects as dropped`);
            } catch (error) {
              console.error('Error marking subjects as dropped:', error);
              // Continue with the process
            }
          }
          
          // Add new subject enrollments
          if (subjectsToAdd.length > 0) {
            let successCount = 0;
            let errorCount = 0;
            
            // Map the student's class to the appropriate curriculum level
            const mappedLevel = mapClassToLevel(updatedStudent.current_class, updatedStudent.curriculum_type);
            console.log(`Mapped ${updatedStudent.current_class} to ${mappedLevel} for ${updatedStudent.curriculum_type}`);
            
            // First try: Check for subjects valid for this student's mapped level
            const validSubjectsQuery = `
              SELECT id, name FROM subjects 
              WHERE id = ANY($1) 
                AND curriculum_type = $2 
                AND level = $3
            `;
            
            const validSubjectsResult = await client.query(
              validSubjectsQuery,
              [subjectsToAdd, updatedStudent.curriculum_type, mappedLevel]
            );
            
            let validSubjectIds = validSubjectsResult.rows.map(row => row.id);
            console.log(`Found ${validSubjectIds.length} valid subjects for ${mappedLevel}`);
            
            // If no subjects are found with this level, try subjects marked as 'all'
            if (validSubjectIds.length === 0) {
              console.log('No subjects found with mapped level, checking for universal subjects');
              
              const universalSubjectsQuery = `
                SELECT id, name FROM subjects 
                WHERE id = ANY($1) 
                  AND curriculum_type = $2 
                  AND level = 'all'
              `;
              
              const universalSubjectsResult = await client.query(
                universalSubjectsQuery,
                [subjectsToAdd, updatedStudent.curriculum_type]
              );
              
              validSubjectIds = universalSubjectsResult.rows.map(row => row.id);
              console.log(`Found ${validSubjectIds.length} universal subjects`);
            }
            
            // If still no subjects, just use any subjects with matching curriculum
            if (validSubjectIds.length === 0) {
              console.log('No specific or universal subjects found, using any with matching curriculum');
              
              const anySubjectsQuery = `
                SELECT id, name, level FROM subjects 
                WHERE id = ANY($1) 
                  AND curriculum_type = $2
              `;
              
              const anySubjectsResult = await client.query(
                anySubjectsQuery,
                [subjectsToAdd, updatedStudent.curriculum_type]
              );
              
              validSubjectIds = anySubjectsResult.rows.map(row => row.id);
              console.log(`Found ${validSubjectIds.length} subjects with matching curriculum`);
              
              if (anySubjectsResult.rows.length > 0) {
                console.log('Subject levels found:', anySubjectsResult.rows.map(row => row.level).filter((v, i, a) => a.indexOf(v) === i));
              }
            }
            
            // Last resort: just use the IDs directly
            if (validSubjectIds.length === 0) {
              console.log('No matching subjects found at all, using subject IDs directly');
              validSubjectIds = subjectsToAdd;
            }
            
            // Find teacher assignments for these subjects in this class
            const teacherAssignmentsResult = await client.query(
              `SELECT subject_id, teacher_id 
               FROM teacher_subjects 
               WHERE class_id = $1 AND academic_session_id = $2 AND subject_id = ANY($3)`,
              [classId, academicSessionId, validSubjectIds]
            );
            
            // Create a map of subject_id to teacher_id
            const subjectTeacherMap = {};
            teacherAssignmentsResult.rows.forEach(row => {
              subjectTeacherMap[row.subject_id] = row.teacher_id;
            });
            
            // Process each subject individually for better error handling
            for (const subjectId of validSubjectIds) {
              try {
                await client.query(
                  `INSERT INTO student_subjects 
                  (student_id, subject_id, class_id, academic_session_id, teacher_id, enrollment_date, is_elective, status)
                  VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, false, 'active')
                  ON CONFLICT (student_id, subject_id, academic_session_id) 
                  DO UPDATE SET status = 'active', teacher_id = $5, updated_at = NOW()`,
                  [id, subjectId, classId, academicSessionId, subjectTeacherMap[subjectId] || null]
                );
                successCount++;
              } catch (error) {
                console.error(`Error adding subject ${subjectId}:`, error);
                errorCount++;
              }
            }
            
            console.log(`Subject enrollment summary: ${successCount} added successfully, ${errorCount} failed`);
          }
        } else {
          console.warn(`No class found or created for level=${updatedStudent.current_class}, stream=${updatedStudent.stream}`);
        }
      } else {
        console.warn('No academic sessions found');
      }
    } else {
      console.log('Skipping subjects update due to missing data:', {
        hasSubjects: !!subjects && Array.isArray(subjects),
        hasClass: !!updatedStudent.current_class,
        hasStream: !!updatedStudent.stream
      });
    }
    
    await client.query('COMMIT');
    
    // Get the complete updated student data with relations
    const completeStudentQuery = `
      SELECT 
        s.*,
        json_build_object(
          'id', p.id,
          'name', concat(p.first_name, ' ', p.last_name),
          'phone', p.phone_primary,
          'email', p.email,
          'relationship', p.relationship,
          'idNumber', p.id_number
        ) AS guardian
      FROM 
        students s
      LEFT JOIN student_parent_relationships spr ON s.id = spr.student_id AND spr.is_primary_contact = true
      LEFT JOIN parents p ON spr.parent_id = p.id
      WHERE s.id = $1
    `;
    
    const completeStudentResult = await pool.query(completeStudentQuery, [id]);
    
    // Get the student's subjects with teacher information - use latest session
    const subjectsQuery = `
      SELECT 
        ss.subject_id AS id,
        s.name,
        s.code,
        COALESCE(CONCAT(t.first_name, ' ', t.last_name), 'Not Assigned') AS teacher,
        ss.status,
        ss.is_elective AS "isElective"
      FROM 
        student_subjects ss
      JOIN subjects s ON ss.subject_id = s.id
      JOIN academic_sessions a ON ss.academic_session_id = a.id
      LEFT JOIN teachers t ON ss.teacher_id = t.id
      WHERE 
        ss.student_id = $1 
        AND ss.status = 'active'
        AND ss.academic_session_id = (
          SELECT id FROM academic_sessions 
          ORDER BY year DESC, term DESC 
          LIMIT 1
        )
    `;
    
    const subjectsResult = await pool.query(subjectsQuery, [id]);
    
    // Combine the data
    const responseData = {
      ...completeStudentResult.rows[0],
      subjects: subjectsResult.rows
    };
    
    return res.status(200).json({
      success: true,
      message: 'Student updated successfully',
      data: responseData
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating student:', error);
    return res.status(500).json({
      success: false,
      error: 'Error updating student information',
      details: error.message
    });
  } finally {
    client.release();
  }
});

const isValidStudentColumn = (key) => {
  // List of valid columns in the students table
  const validColumns = [
    'first_name',
    'last_name',
    'other_names',
    'admission_number',
    'date_of_birth',
    'gender',
    'address',
    'nationality',
    'nemis_upi',
    'current_class',
    'stream',
    'previous_school',
    'admission_date',
    'curriculum_type',
    'student_type',
    'blood_group',
    'allergies',
    'emergency_contact_name',
    'emergency_contact_phone',
    'medical_conditions',
    'conditions' // Include this if your code sometimes uses 'conditions' instead of 'medical_conditions'
  ];
  
  return validColumns.includes(key);
};

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

    // Log some info for debugging - remove in production
    console.log(`Attempting to delete student ID: ${studentId}, Admission Number: ${student.admission_number}`);

    // Query to check if any table references this student
    const tables = [
      { name: 'attendance', column: 'student_id' },
      { name: 'exam_results', column: 'student_id' },
      { name: 'student_result_summary', column: 'student_id' },
      { name: 'student_subjects', column: 'student_id' },
      { name: 'dormitory_allocations', column: 'student_id' },
      { name: 'transport_allocations', column: 'student_id' },
      { name: 'fee_payments', column: 'student_id' },
      { name: 'student_fee_details', column: 'student_id' },
      { name: 'book_borrowing', column: 'student_id' },
      { name: 'disciplinary_incidents', column: 'student_id' },
      { name: 'attendance_summary', column: 'student_id' }
    ];

    // Safely delete from each table, checking for column existence first
    for (const table of tables) {
      try {
        // Check if column exists in table
        const columnCheckQuery = `
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = '${table.name}' 
          AND column_name = '${table.column}'
        `;
        const columnCheckResult = await client.query(columnCheckQuery);
        
        if (columnCheckResult.rows.length > 0) {
          // Column exists, proceed with deletion
          console.log(`Deleting from ${table.name} where ${table.column}=${studentId}`);
          await client.query(`DELETE FROM ${table.name} WHERE ${table.column} = $1`, [studentId]);
        } else {
          console.log(`Table ${table.name} doesn't have column ${table.column}, skipping`);
        }
      } catch (error) {
        console.log(`Error when trying to delete from ${table.name}: ${error.message}`);
        // Continue with other tables instead of aborting the entire operation
      }
    }

    // Get parent relationships
    const parentQuery = `
            SELECT parent_id 
            FROM student_parent_relationships 
            WHERE student_id = $1
        `;
    const parentResult = await client.query(parentQuery, [studentId]);
    const parentIds = parentResult.rows.map((row) => row.parent_id);

    // Delete student-parent relationships
    await client.query(
      `
            DELETE FROM student_parent_relationships 
            WHERE student_id = $1
        `,
      [studentId]
    );

    // Delete parents if they have no other children
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

    // Finally delete the student
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
      nationality,
      nemisUpi,
      previousSchool,
      bloodGroup,

      // Student Type and Related Info
      studentType,
      address,
      busRoute,
      hostel,
      roomNumber,

      // Medical Information
      medicalInfo,

      // Guardian Information
      guardianFirstName,
      guardianLastName,
      guardianIdNumber,
      guardianPhone,
      guardianPhoneSecondary,
      guardianEmail,
      guardianRelation,
      guardianAddress,
      
      // Subject Selection - New field
      selectedSubjects
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
                allergies, blood_group, nationality, nemis_upi, previous_school,
                emergency_contact_name, emergency_contact_phone,
                student_type, status, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, CURRENT_TIMESTAMP)
            RETURNING id
        `;

    const studentParams = [
      admissionNo,
      firstName,
      lastName,
      otherNames || null,
      dateOfBirth,
      gender.toLowerCase(),
      address || null,
      new Date(), // admission_date is today
      curriculumType,
      className,
      stream,
      allergiesArray,
      bloodGroup || null,
      nationality || 'Kenyan',
      nemisUpi || null,
      previousSchool || null,
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
                first_name, last_name, id_number, relationship, email, 
                phone_primary, phone_secondary, address, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
            RETURNING id
        `;

    const guardianParams = [
      guardianFirstName,
      guardianLastName,
      guardianIdNumber || null,
      guardianRelation,
      guardianEmail || null,
      guardianPhone,
      guardianPhoneSecondary || null,
      guardianAddress,
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

    // Find current academic session
    const sessionQuery = `SELECT id FROM academic_sessions WHERE is_current = true LIMIT 1`;
    const sessionResult = await client.query(sessionQuery);
    const academicSessionId = sessionResult.rows[0]?.id;

    // 4. If academicSessionId exists and we have subjects, create student-subject relationships
    if (academicSessionId && Array.isArray(selectedSubjects) && selectedSubjects.length > 0) {
      // Get the class ID from class name and stream
      const classQuery = `
        SELECT id FROM classes 
        WHERE level = $1 AND stream = $2 
        AND academic_session_id = $3
        LIMIT 1
      `;
      
      const classResult = await client.query(classQuery, [className, stream, academicSessionId]);
      const classId = classResult.rows[0]?.id;
      
      if (classId) {
        // Prepare the values for multiple inserts
        const subjectValues = [];
        const subjectParams = [];
        let paramIndex = 1;
        
        for (const subjectId of selectedSubjects) {
          subjectValues.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, CURRENT_DATE, $${paramIndex + 5}, $${paramIndex + 6}, CURRENT_TIMESTAMP)`);
          subjectParams.push(
            studentId,
            subjectId,
            classId,
            academicSessionId,
            false, // is_elective - can be determined by business logic later
            'active', // status
            null  // teacher_id - will be assigned later or populated from teacher_subjects
          );
          paramIndex += 7;
        }
        
        if (subjectValues.length > 0) {
          const subjectEnrollmentQuery = `
            INSERT INTO student_subjects (
              student_id, subject_id, class_id, academic_session_id, 
              is_elective, enrollment_date, status, teacher_id, created_at
            ) VALUES ${subjectValues.join(', ')}
          `;
          
          await client.query(subjectEnrollmentQuery, subjectParams);
          
          // Optionally, we can also try to assign teachers based on existing teacher_subjects mappings
          const assignTeachersQuery = `
            UPDATE student_subjects ss
            SET teacher_id = ts.teacher_id
            FROM teacher_subjects ts
            WHERE ss.student_id = $1
            AND ss.subject_id = ts.subject_id
            AND ss.class_id = ts.class_id
            AND ss.academic_session_id = ts.academic_session_id
          `;
          
          await client.query(assignTeachersQuery, [studentId]);
        }
      }
    }

    // 5. If boarder, create dormitory allocation
    if (studentType === "Boarder" && hostel && academicSessionId) {
      // Get dormitory id from name
      const dormQuery = `SELECT id FROM dormitories WHERE name = $1 LIMIT 1`;
      const dormResult = await client.query(dormQuery, [hostel]);
      const dormitoryId = dormResult.rows[0]?.id;

      if (dormitoryId) {
        // Check if a room number was specified
        if (roomNumber) {
          // Check if the specified room exists and has space
          const specificRoomQuery = `
            SELECT id FROM dormitory_rooms 
            WHERE dormitory_id = $1 
            AND room_number = $2
            AND occupied < capacity
            LIMIT 1
          `;
          const specificRoomResult = await client.query(specificRoomQuery, [dormitoryId, roomNumber]);
          const specificRoomId = specificRoomResult.rows[0]?.id;
          
          if (specificRoomId) {
            // Find an available bed number
            const bedQuery = `
              SELECT MAX(CAST(bed_number AS INTEGER)) as max_bed
              FROM dormitory_allocations
              WHERE room_id = $1
            `;
            const bedResult = await client.query(bedQuery, [specificRoomId]);
            const nextBed = (bedResult.rows[0]?.max_bed || 0) + 1;

            const dormAllocationQuery = `
              INSERT INTO dormitory_allocations (
                student_id, room_id, bed_number, academic_session_id, 
                allocation_date, status, created_at
              ) VALUES ($1, $2, $3, $4, CURRENT_DATE, 'active', CURRENT_TIMESTAMP)
            `;

            await client.query(dormAllocationQuery, [
              studentId,
              specificRoomId,
              nextBed.toString(),
              academicSessionId
            ]);
          }
        } else {
          // Find an available room automatically
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

    // 6. If day scholar, create transport allocation
    if (studentType === "Day Scholar" && busRoute && busRoute !== "None" && academicSessionId) {
      // Get a pickup stop for the route (first one as default)
      const stopQuery = `
        SELECT id FROM route_stops 
        WHERE route_id = $1 
        ORDER BY stop_order ASC 
        LIMIT 1
      `;
      const stopResult = await client.query(stopQuery, [busRoute]);
      const pickupStopId = stopResult.rows[0]?.id;

      if (pickupStopId) {
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
        subjectsEnrolled: selectedSubjects?.length || 0
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
      } else if (error.constraint?.includes("student_subjects_student_id_subject_id")) {
        return res.status(400).json({
          success: false,
          error: "Duplicate subject enrollment detected",
        });
      }
    }

    res.status(500).json({
      success: false,
      error: "Failed to add student. " + (error.message || "Unknown error")
    });
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


router.post("/enroll-subjects", authorizeRoles("admin"), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { enrollments } = req.body;
    console.log("Enrollment data received:", enrollments);
    
    if (!Array.isArray(enrollments) || enrollments.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Enrollment data must be a non-empty array"
      });
    }
    
    // Get the latest academic session if needed for any enrollment
    let latestSessionId = null;
    const needsSessionId = enrollments.some(enrollment => !enrollment.academicSessionId);
    
    if (needsSessionId) {
      const sessionResult = await client.query(
        'SELECT id FROM academic_sessions ORDER BY year DESC, term DESC LIMIT 1'
      );
      
      if (sessionResult.rows.length > 0) {
        latestSessionId = sessionResult.rows[0].id;
        console.log('Using latest academic session ID for missing session IDs:', latestSessionId);
      } else {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          error: "No academic sessions found in the system"
        });
      }
    }
    
    // Prepare the values for multiple inserts
    const subjectValues = [];
    const subjectParams = [];
    let paramIndex = 1;
   
    for (const enrollment of enrollments) {
      // Use provided academicSessionId or default to latest
      const academicSessionId = enrollment.academicSessionId || latestSessionId;
      const { studentId, subjectId, classId, isElective = false, status = 'active' } = enrollment;
      
      // Validate required fields
      if (!studentId || !subjectId || !classId) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          error: "Missing required fields in enrollment data"
        });
      }
      
      subjectValues.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, CURRENT_DATE, $${paramIndex + 5})`);
      subjectParams.push(
        studentId,
        subjectId,
        classId,
        academicSessionId,
        isElective,
        status
      );
      paramIndex += 6;
    }
   
    // Execute the batch insert
    const subjectEnrollmentQuery = `
      INSERT INTO student_subjects (
        student_id, subject_id, class_id, academic_session_id,
        is_elective, enrollment_date, status
      ) VALUES ${subjectValues.join(', ')}
      ON CONFLICT (student_id, subject_id, academic_session_id)
      DO UPDATE SET
        class_id = EXCLUDED.class_id,
        is_elective = EXCLUDED.is_elective,
        status = EXCLUDED.status,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `;
   
    const enrollmentResult = await client.query(subjectEnrollmentQuery, subjectParams);
    console.log(`Created/updated ${enrollmentResult.rowCount} subject enrollments`);
    
    // Optionally assign teachers based on existing teacher_subjects mappings
    for (let i = 0; i < enrollments.length; i++) {
      const enrollment = enrollments[i];
      // Use provided academicSessionId or default to latest
      const academicSessionId = enrollment.academicSessionId || latestSessionId;
      
      const assignTeachersQuery = `
        UPDATE student_subjects ss
        SET teacher_id = ts.teacher_id
        FROM teacher_subjects ts
        WHERE ss.student_id = $1
        AND ss.subject_id = $2
        AND ss.class_id = $3
        AND ss.academic_session_id = $4
        AND ts.subject_id = ss.subject_id
        AND ts.class_id = ss.class_id
        AND ts.academic_session_id = ss.academic_session_id
      `;
     
      const teacherAssignResult = await client.query(assignTeachersQuery, [
        enrollment.studentId,
        enrollment.subjectId,
        enrollment.classId,
        academicSessionId
      ]);
      
      if (teacherAssignResult.rowCount > 0) {
        console.log(`Assigned teacher for student ${enrollment.studentId}, subject ${enrollment.subjectId}`);
      }
    }
    
    await client.query("COMMIT");
    
    res.status(201).json({
      success: true,
      message: "Student subject enrollments created successfully",
      data: {
        count: enrollmentResult.rowCount,
        enrollmentIds: enrollmentResult.rows.map(row => row.id)
      }
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error enrolling subjects:", error);
    
    // Provide specific error messages
    if (error.code === "23505") {
      // Unique constraint violation
      return res.status(400).json({
        success: false,
        error: "Duplicate enrollment detected"
      });
    } else if (error.code === "23503") {
      // Foreign key violation
      return res.status(400).json({
        success: false,
        error: "Invalid student, subject, class, or academic session ID"
      });
    }
    
    res.status(500).json({
      success: false,
      error: "Failed to enroll subjects: " + (error.message || "Unknown error")
    });
  } finally {
    client.release();
  }
});

export default router;