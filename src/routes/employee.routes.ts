import { Router } from 'express';
import { authenticate, requireEmployee } from '../middleware/auth.middleware';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth.middleware';

const router = Router();
const prisma = new PrismaClient();

router.use(authenticate, requireEmployee);

router.get('/dashboard', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const now = new Date();
    const [total, completed, pending, inProgress] = await Promise.all([
      prisma.task.count({ where: { assignedToId: userId } }),
      prisma.task.count({ where: { assignedToId: userId, status: 'COMPLETED' } }),
      prisma.task.count({ where: { assignedToId: userId, status: 'NOT_STARTED' } }),
      prisma.task.count({ where: { assignedToId: userId, status: 'IN_PROGRESS' } }),
    ]);
    const overdue = await prisma.task.count({ where: { assignedToId: userId, status: { not: 'COMPLETED' }, dueAt: { lt: now } } });

    const upcoming = await prisma.task.findMany({
      where: { assignedToId: userId, status: { not: 'COMPLETED' }, dueAt: { gte: now } },
      orderBy: { dueAt: 'asc' }, take: 5,
      include: { createdBy: { select: { firstName: true, lastName: true } } },
    });

    const recentActivity = await prisma.activityLog.findMany({
      where: { userId }, orderBy: { createdAt: 'desc' }, take: 10,
      include: { task: { select: { id: true, title: true } } },
    });

    res.json({ stats: { total, completed, pending, inProgress, overdue }, upcoming, recentActivity });
  } catch { res.status(500).json({ error: 'Failed to fetch dashboard' }); }
});

export default router;
