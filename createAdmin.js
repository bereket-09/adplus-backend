require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('./src/models/user.model.js');

async function createAdmin() {
  try {
    // If you are using a different environment variable for MongoDB connection, update it below.
    const mongoUri = process.env.MONGO_URI; 
    
    if (!mongoUri) {
        throw new Error('MONGO_URI is missing in .env file');
    }

    await mongoose.connect(mongoUri);
    console.log('✅ Connected to Database');

    // Hash the password securely
    const hashedPassword = await bcrypt.hash('TempPass123', 10);
    
    const adminUser = new User({
      name: 'System Admin',
      email: 'admin@example.com',
      password: hashedPassword,
      role: 'admin',
      status: 'active'
    });

    await adminUser.save();
    console.log('🎉 Admin account created successfully!');
    console.log('Email: admin@example.com');
    console.log('Password: TempPass123');

  } catch (error) {
    if (error.code === 11000) {
      console.log('⚠️  Admin user already exists with this email!');
    } else {
      console.error('❌ Error creating admin:', error);
    }
  } finally {
    // Ensure we close the connection
    await mongoose.connection.close();
    console.log('Database connection closed.');
  }
}

createAdmin();
