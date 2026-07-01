import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { getTasks, getMyTasks, getTask, createTask, updateTask, deleteTask, addComment } from '../controllers/task.controller';

const router = Router();
router.use(authenticate);

router.get('/mine', getMyTasks);
router.get('/', getTasks);
router.get('/:id', getTask);
router.post('/', createTask);
router.put('/:id', updateTask);
router.delete('/:id', deleteTask);
router.post('/:id/comments', addComment);

export default router;
