import { Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from '../middleware/auth.middleware';
import { io } from '../index';
import { emitToUser } from '../services/socket.service';

const prisma = new PrismaClient();

const taskInclude = {
  assignedTo: { select: { id: true, firstName: true, lastName: true, username: true, avatar: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true, username: true } },
  comments: {
    include: { author: { select: { id: true, firstName: true, lastName: true, avatar: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
  attachments: true,
  _count: { select: { comments: true } },
};

export async function getTasks(req: AuthRequest, res: Response) {
  try {
    const { status, priority, assignedTo, search, dateFrom, dateTo, page = '1', limit = '20' } = req.query;
    const now = new Date();
    const where: any = {};
    if (req.user!.role === 'EMPLOYEE') where.assignedToId = req.user!.id;
    // ADMIN sees only their team's tasks + tasks they created; SUPER_ADMIN sees all
    if (req.user!.role === 'ADMIN') where.AND = [{ OR: [{ assignedTo: { managerId: req.user!.id } }, { createdById: req.user!.id }] }];
    if (status) where.status = status;
    if (priority) where.priority = priority;
    if (assignedTo) where.assignedToId = assignedTo;
    if (dateFrom || dateTo) { where.dueAt = {}; if (dateFrom) where.dueAt.gte = new Date(dateFrom as string); if (dateTo) where.dueAt.lte = new Date(dateTo as string); }
    if (search) where.OR = [{ title: { contains: search as string, mode: 'insensitive' } }, { description: { contains: search as string, mode: 'insensitive' } }];

    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);
    const [total, tasks] = await Promise.all([
      prisma.task.count({ where }),
      prisma.task.findMany({ where, include: taskInclude, orderBy: { createdAt: 'desc' }, skip, take: parseInt(limit as string) }),
    ]);

    const enriched = tasks.map(t => ({ ...t, isOverdue: t.status !== 'COMPLETED' && t.dueAt < now }));
    res.json({ tasks: enriched, total, page: parseInt(page as string) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
}

export async function getMyTasks(req: AuthRequest, res: Response) {
  try {
    const { status, priority } = req.query;
    const now = new Date();
    const where: any = { assignedToId: req.user!.id };
    if (status) where.status = status;
    if (priority) where.priority = priority;

    const tasks = await prisma.task.findMany({
      where,
      include: taskInclude,
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
    });

    const enriched = tasks.map(t => ({ ...t, isOverdue: t.status !== 'COMPLETED' && t.dueAt < now }));

    const stats = {
      total: tasks.length,
      inProgress: tasks.filter(t => t.status === 'IN_PROGRESS').length,
      completed: tasks.filter(t => t.status === 'COMPLETED').length,
      overdue: tasks.filter(t => t.status !== 'COMPLETED' && t.dueAt < now).length,
      notStarted: tasks.filter(t => t.status === 'NOT_STARTED').length,
    };

    res.json({ tasks: enriched, stats });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
}

export async function getTask(req: AuthRequest, res: Response) {
  try {
    const task = await prisma.task.findUnique({ where: { id: req.params.id }, include: taskInclude });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (req.user!.role === 'EMPLOYEE' && task.assignedToId !== req.user!.id) return res.status(403).json({ error: 'Access denied' });
    res.json({ ...task, isOverdue: task.status !== 'COMPLETED' && task.dueAt < new Date() });
  } catch {
    res.status(500).json({ error: 'Failed to fetch task' });
  }
}

export async function createTask(req: AuthRequest, res: Response) {
  try {
    const { title, description, priority, dueDate, dueTime, dueAt: dueAtRaw, assignedToId, notes } = req.body;
    if (!title || !assignedToId) return res.status(400).json({ error: 'Missing required fields' });

    // Hierarchy rules: SUPER_ADMIN can assign to anyone; ADMIN only to their own employees
    const assignee = await prisma.user.findUnique({ where: { id: assignedToId }, select: { role: true, managerId: true } });
    if (!assignee) return res.status(404).json({ error: 'Assignee not found' });
    if (req.user!.role === 'ADMIN') {
      if (assignee.role !== 'EMPLOYEE' || assignee.managerId !== req.user!.id) {
        return res.status(403).json({ error: 'You can only assign tasks to your own team members' });
      }
    }

    let dueAt: Date;
    if (dueAtRaw) {
      dueAt = new Date(dueAtRaw);
    } else if (dueDate && dueTime) {
      dueAt = new Date(`${dueDate}T${dueTime}`);
    } else {
      return res.status(400).json({ error: 'Due date/time is required' });
    }

    const task = await prisma.task.create({
      data: { title, description, priority: priority?.toUpperCase() || 'MEDIUM', dueAt, assignedToId, createdById: req.user!.id, notes },
      include: taskInclude,
    });

    await prisma.activityLog.create({ data: { action: 'TASK_CREATED', description: `Task "${title}" created and assigned`, userId: req.user!.id, taskId: task.id } });

    const notif = await prisma.notification.create({
      data: { type: 'TASK_ASSIGNED', title: 'New Task Assigned', message: `You have been assigned: "${title}"`, recipientId: assignedToId, senderId: req.user!.id, taskId: task.id },
    });
    emitToUser(io, assignedToId, 'notification', notif);
    emitToUser(io, assignedToId, 'task:assigned', task);

    res.status(201).json(task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create task' });
  }
}

export async function updateTask(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const existing = await prisma.task.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    if (req.user!.role === 'EMPLOYEE' && existing.assignedToId !== req.user!.id) return res.status(403).json({ error: 'Access denied' });

    const { title, description, priority, dueDate, dueTime, dueAt: dueAtRaw, assignedToId, notes, status, isActive } = req.body;

    let dueAt: Date | undefined;
    if (dueAtRaw) dueAt = new Date(dueAtRaw);
    else if (dueDate && dueTime) dueAt = new Date(`${dueDate}T${dueTime}`);

    const completedAt = status === 'COMPLETED' && existing.status !== 'COMPLETED' ? new Date() : status !== 'COMPLETED' ? null : undefined;

    const task = await prisma.task.update({
      where: { id },
      data: {
        ...(title && { title }), ...(description !== undefined && { description }),
        ...(priority && { priority: priority.toUpperCase() }), ...(dueAt && { dueAt }),
        ...(assignedToId && { assignedToId }), ...(notes !== undefined && { notes }),
        ...(status && { status }), ...(completedAt !== undefined && { completedAt }),
      },
      include: taskInclude,
    });

    await prisma.activityLog.create({ data: { action: 'TASK_UPDATED', description: `Task "${task.title}" updated`, userId: req.user!.id, taskId: task.id } });

    if (status === 'COMPLETED') {
      const admins = await prisma.user.findMany({ where: { role: 'ADMIN' } });
      for (const admin of admins) {
        const notif = await prisma.notification.create({
          data: { type: 'TASK_COMPLETED', title: 'Task Completed', message: `"${task.title}" marked as completed`, recipientId: admin.id, senderId: req.user!.id, taskId: task.id },
        });
        emitToUser(io, admin.id, 'notification', notif);
      }
    }

    emitToUser(io, task.assignedToId, 'task:updated', task);
    res.json(task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update task' });
  }
}

export async function deleteTask(req: AuthRequest, res: Response) {
  try {
    if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' });
    await prisma.task.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to delete task' });
  }
}

export async function addComment(req: AuthRequest, res: Response) {
  try {
    const { id } = req.params;
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Comment content required' });

    const task = await prisma.task.findUnique({ where: { id } });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (req.user!.role === 'EMPLOYEE' && task.assignedToId !== req.user!.id) return res.status(403).json({ error: 'Access denied' });

    const comment = await prisma.taskComment.create({
      data: { content, taskId: id, authorId: req.user!.id },
      include: { author: { select: { id: true, firstName: true, lastName: true, avatar: true } } },
    });

    await prisma.activityLog.create({ data: { action: 'COMMENT_ADDED', description: `Comment added to task`, userId: req.user!.id, taskId: id } });

    if (req.user!.role === 'EMPLOYEE') {
      const admins = await prisma.user.findMany({ where: { role: 'ADMIN' } });
      for (const admin of admins) {
        const notif = await prisma.notification.create({
          data: { type: 'TASK_COMMENTED', title: 'New Comment', message: `Comment added to "${task.title}"`, recipientId: admin.id, senderId: req.user!.id, taskId: id },
        });
        emitToUser(io, admin.id, 'notification', notif);
      }
    }

    emitToUser(io, task.assignedToId, 'task:comment', { taskId: id, comment });
    res.status(201).json(comment);
  } catch {
    res.status(500).json({ error: 'Failed to add comment' });
  }
}
