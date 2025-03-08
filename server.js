import dotenv from 'dotenv';
import app from './app.js';

dotenv.config();

const PORT = process.env.PORT || 5010;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});