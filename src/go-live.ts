import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

function generatePassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '@#$!';
  const pick = (set: string, n: number) => Array.from({ length: n }, () => set[Math.floor(Math.random() * set.length)]).join('');
  return pick(upper, 2) + pick(lower, 5) + pick(digits, 3) + pick(symbols, 2);
}

async function main() {
  console.log('🧹 Removing ALL demo data...');
  await prisma.taskComment.deleteMany();
  await prisma.taskAttachment.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.activityLog.deleteMany();
  await prisma.task.deleteMany();
  await prisma.user.deleteMany();
  console.log('✅ All demo data removed (users, tasks, comments, notifications, logs)');

  const password = generatePassword();
  const hash = await bcrypt.hash(password, 12);
  await prisma.user.create({
    data: {
      username: 'admin',
      email: 'dilipkumarpandit.official@gmail.com',
      passwordHash: hash,
      firstName: 'Dilip',
      lastName: 'Pandit',
      role: 'ADMIN',
      mustChangePassword: false,
      isActive: true,
    },
  });
  console.log('✅ Production admin created');
  console.log('');
  console.log('══════════════════════════════════════');
  console.log('  ADMIN LOGIN — SAVE THESE CREDENTIALS');
  console.log('  Username: admin');
  console.log(`  Password: ${password}`);
  console.log('══════════════════════════════════════');
}

main().finally(() => prisma.$disconnect());
