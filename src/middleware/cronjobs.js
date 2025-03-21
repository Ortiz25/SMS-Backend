import pool from '../config/database.js';
import cron from 'node-cron';



// Schedule task to run daily at 1:00 AM
cron.schedule('0 1 * * *', async () => {
    try {
      await pool.query('SELECT restore_student_status_after_disciplinary_period()');
      console.log('Student status restoration process completed');
    } catch (err) {
      console.error('Error in status restoration:', err);
    }
  });


  cron.schedule('0 0 * * *', async () => {
    try {
      await pool.query('SELECT restore_teacher_status_after_leave()');
      console.log('Teacher Leave status restoration process completed');
    } catch (err) {
      console.error('Error in Leave status restoration:', err);
    }
  });