import express from "express";
import pool from "../config/database.js";
import jwt from 'jsonwebtoken';
import { MailerSend, EmailParams, Sender, Recipient } from "mailersend";
import bcrypt from 'bcryptjs';

const router = express.Router();

// Initialize MailerSend
const mailerSend = new MailerSend({
  apiKey: process.env.MAILERSEND_API_KEY,
});

router.post("/forgotpassword", async (req, res) => {
  const { email } = req.body;
  console.log("Password reset requested for:", email);
  
  try {
    // Check if user exists
    const result = await pool.query("SELECT id, username FROM users WHERE email = $1", [
      email,
    ]);
 
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }
 
    const userId = result.rows[0].id;
    const username = result.rows[0].username;
 
    const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now
 
    // Generate a unique token
    const token = jwt.sign({ userId }, process.env.SECRET_KEY, {
      expiresIn: "1h",
    });
 
    // Save the token and expiration in database
    await pool.query(
      "UPDATE users SET resetPasswordToken = $1, reset_password_expires = $2 WHERE id = $3",
      [token, expiresAt, userId]
    );
 
    const resetLink = `${process.env.FRONTEND_URL || 'http://sms.teqova.biz/'}/resetpassword?token=${token}`;
 
    // Email content
    const subject = "Password Reset Request";
    const htmlMessage = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2c3e50;">Password Reset Request</h2>
        <p>Hello ${username || 'there'},</p>
        <p>We received a request to reset your password. If you didn't make this request, you can ignore this email.</p>
        <p>To reset your password, please click the button below:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetLink}" style="background-color: #3498db; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">Reset Password</a>
        </div>
        <p>Or copy and paste this link in your browser:</p>
        <p><a href="${resetLink}">${resetLink}</a></p>
        <p>This link will expire in 1 hour.</p>
        <p>Thank you,<br>School Management Team</p>
      </div>
    `;
    
    const textMessage = `
      Password Reset Request
      
      Hello ${username || 'there'},
      
      We received a request to reset your password. If you didn't make this request, you can ignore this email.
      
      To reset your password, please visit this link:
      ${resetLink}
      
      This link will expire in 1 hour.
      
      Thank you,
      School Management Team
    `;
 
    // Send email using MailerSend
    try {
      // Set sender from environment or use default
      const senderEmail = process.env.MAILERSEND_FROM_EMAIL || 'noreply@example.com';
      const senderName = process.env.MAILERSEND_FROM_NAME || 'School Management System';
      const sentFrom = new Sender(senderEmail, senderName);
      
      // Create email parameters
      const emailParams = new EmailParams()
        .setFrom(sentFrom)
        .setTo([new Recipient(email)])
        .setReplyTo(sentFrom)
        .setSubject(subject)
        .setHtml(htmlMessage)
        .setText(textMessage);
      
      // Send the email
      await mailerSend.email.send(emailParams);
      console.log(`Password reset email sent successfully to ${email}`);
      
      // Return success response without exposing the token
      res.json({ 
        message: "Password reset link sent to your email.",
        success: true
      });
    } catch (emailError) {
      console.error("Email sending error:", emailError);
      
      // Still return success to user to prevent user enumeration attacks
      // but log the error for administrators
      res.json({ 
        message: "If your email exists in our system, you will receive a password reset link shortly.",
        success: true
      });
    }
  } catch (error) {
    console.error("Password reset error:", error);
    res.status(500).json({ 
      error: "An error occurred while processing your request.",
      success: false
    });
  }
});

// Handle password reset
router.post("/resetpassword", async (req, res) => {
    const { token, newPassword } = req.body;
    console.log(token, newPassword);
    try {
      jwt.verify(token, process.env.SECRET_KEY, async function (err, foundUser) {
        if (err) {
          if (err.message === "jwt expired") {
            res.json({ message: "token expired" });
          }
        }
        if (foundUser) {
          console.log(foundUser.userId);
          const hashedPassword = await bcrypt.hash(newPassword, 10);
  
          await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [
            hashedPassword,
            foundUser.userId,
          ]);
  
          res.status(200).json({ message: "Password reset successful" });
        }
      });
    } catch (error) {
      if (error.name === "TokenExpiredError") {
        return res.status(400).json({ message: "Token expired" });
      }
      console.error(error);
      res.status(500).json({ message: "Internal server error" });
    }
  });
  

export default router;