import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth.middleware';

const router = Router();
const prisma = new PrismaClient();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { recipientId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { sender: { select: { firstName: true, lastName: true } }, task: { select: { id: true, title: true } } },
    });
    res.json(notifications);
  } catch { res.status(500).json({ error: 'Failed to fetch notifications' }); }
});

router.patch('/:id/read', async (req: AuthRequest, res) => {
  try {
    await prisma.notification.update({ where: { id: req.params.id, recipientId: req.user!.id }, data: { isRead: true } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed to mark as read' }); }
});

router.patch('/read-all', async (req: AuthRequest, res) => {
  try {
    await prisma.notification.updateMany({ where: { recipientId: req.user!.id, isRead: false }, data: { isRead: true } });
    res.json({ success: true });
  } catch { res.status(500).json({ error: 'Failed to mark all as read' }); }
});

export default router;
