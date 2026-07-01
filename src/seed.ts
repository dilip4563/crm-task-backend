import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Admins
  const adminData = [
    { username: 'admin1', email: 'admin1@crm.com', firstName: 'Admin', lastName: 'One', password: 'Admin@123' },
    { username: 'admin2', email: 'admin2@crm.com', firstName: 'Admin', lastName: 'Two', password: 'Admin@456' },
  ];

  const admins = [];
  for (const a of adminData) {
    const hash = await bcrypt.hash(a.password, 12);
    const admin = await prisma.user.upsert({
      where: { username: a.username },
      update: {},
      create: { username: a.username, email: a.email, passwordHash: hash, firstName: a.firstName, lastName: a.lastName, role: 'ADMIN', mustChangePassword: false },
    });
    admins.push(admin);
    console.log(`✅ Admin: ${a.username} / ${a.password}`);
  }

  // Employees
  const employeeNames = [
    { first: 'Rahul', last: 'Sharma' }, { first: 'Priya', last: 'Patel' }, { first: 'Amit', last: 'Verma' },
    { first: 'Sneha', last: 'Gupta' }, { first: 'Vikram', last: 'Singh' }, { first: 'Pooja', last: 'Mehta' },
    { first: 'Arjun', last: 'Kumar' }, { first: 'Divya', last: 'Joshi' }, { first: 'Karan', last: 'Malhotra' },
    { first: 'Neha', last: 'Agarwal' }, { first: 'Rohan', last: 'Bose' }, { first: 'Anjali', last: 'Reddy' },
    { first: 'Sanjay', last: 'Nair' }, { first: 'Meera', last: 'Iyer' }, { first: 'Deepak', last: 'Chopra' },
  ];

  const employees = [];
  for (let i = 0; i < 15; i++) {
    const username = `employee${String(i + 1).padStart(2, '0')}`;
    const defaultPassword = 'Employee@123';
    const hash = await bcrypt.hash(defaultPassword, 12);
    const emp = await prisma.user.upsert({
      where: { username },
      update: {},
      create: {
        username, email: `${username}@crm.com`, passwordHash: hash,
        firstName: employeeNames[i].first, lastName: employeeNames[i].last,
        role: 'EMPLOYEE', mustChangePassword: true,
      },
    });
    employees.push(emp);
    console.log(`✅ Employee: ${username} / ${defaultPassword}`);
  }

  // Sample tasks
  const now = new Date();
  const future = (d: number) => new Date(now.getTime() + d * 86400000);
  const past = (d: number) => new Date(now.getTime() - d * 86400000);

  const sampleTasks = [
    { title: 'Complete Q3 Sales Report', priority: 'HIGH', dueAt: future(2), status: 'IN_PROGRESS', assignedIdx: 0 },
    { title: 'Client Onboarding - Acme Corp', priority: 'CRITICAL', dueAt: future(1), status: 'NOT_STARTED', assignedIdx: 1 },
    { title: 'Update CRM Database', priority: 'MEDIUM', dueAt: future(5), status: 'NOT_STARTED', assignedIdx: 2 },
    { title: 'Prepare Monthly Budget', priority: 'HIGH', dueAt: past(1), status: 'NOT_STARTED', assignedIdx: 3 },
    { title: 'Team Performance Review', priority: 'MEDIUM', dueAt: future(7), status: 'NOT_STARTED', assignedIdx: 4 },
    { title: 'Website Audit', priority: 'LOW', dueAt: future(10), status: 'NOT_STARTED', assignedIdx: 5 },
    { title: 'Social Media Campaign', priority: 'MEDIUM', dueAt: future(3), status: 'IN_PROGRESS', assignedIdx: 6 },
    { title: 'Product Demo - Client XYZ', priority: 'CRITICAL', dueAt: future(1), status: 'NOT_STARTED', assignedIdx: 7 },
    { title: 'HR Policy Documentation', priority: 'LOW', dueAt: future(14), status: 'COMPLETED', assignedIdx: 8 },
    { title: 'Invoice Processing - Batch 12', priority: 'HIGH', dueAt: past(2), status: 'NOT_STARTED', assignedIdx: 9 },
    { title: 'Security Audit', priority: 'CRITICAL', dueAt: future(5), status: 'IN_PROGRESS', assignedIdx: 10 },
    { title: 'Customer Feedback Survey', priority: 'LOW', dueAt: future(8), status: 'NOT_STARTED', assignedIdx: 11 },
    { title: 'Employee Training Schedule', priority: 'MEDIUM', dueAt: future(4), status: 'WAITING_APPROVAL', assignedIdx: 12 },
    { title: 'Legal Compliance Check', priority: 'CRITICAL', dueAt: past(3), status: 'COMPLETED', assignedIdx: 13 },
    { title: 'Vendor Contract Renewal', priority: 'HIGH', dueAt: future(6), status: 'NOT_STARTED', assignedIdx: 14 },
    { title: 'Q4 Planning Meeting Prep', priority: 'HIGH', dueAt: future(2), status: 'IN_PROGRESS', assignedIdx: 0 },
    { title: 'Data Backup Verification', priority: 'MEDIUM', dueAt: future(1), status: 'NOT_STARTED', assignedIdx: 1 },
    { title: 'Office Supply Inventory', priority: 'LOW', dueAt: future(15), status: 'NOT_STARTED', assignedIdx: 2 },
    { title: 'Marketing Strategy Review', priority: 'HIGH', dueAt: future(3), status: 'COMPLETED', assignedIdx: 3 },
    { title: 'IT Infrastructure Upgrade', priority: 'CRITICAL', dueAt: future(4), status: 'IN_PROGRESS', assignedIdx: 4 },
  ];

  for (const t of sampleTasks) {
    await prisma.task.create({
      data: {
        title: t.title, priority: t.priority as any, dueAt: t.dueAt,
        status: t.status as any, assignedToId: employees[t.assignedIdx].id,
        createdById: admins[0].id, completedAt: t.status === 'COMPLETED' ? new Date() : null,
      },
    });
  }

  console.log(`\n✅ Seeded: 2 admins, 15 employees, ${sampleTasks.length} tasks`);
  console.log('\n📋 Login Credentials:');
  console.log('  Admin:    admin1 / Admin@123');
  console.log('  Admin:    admin2 / Admin@456');
  console.log('  Employee: employee01–15 / Employee@123 (must change on first login)');
}

main().catch(console.error).finally(() => prisma.$disconnect());
