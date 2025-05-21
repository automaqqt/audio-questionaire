import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma'; // Adjust path
import bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';

export async function POST(req: Request) {
  try {
    const { name, email, password, role } = await req.json();

    if (!name || !email || !password) {
      return NextResponse.json({ message: 'Name, email, and password are required.' }, { status: 400 });
    }
    if (!/\S+@\S+\.\S+/.test(email)) {
      return NextResponse.json({ message: 'Invalid email format.' }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ message: 'Password must be at least 8 characters long.' }, { status: 400 });
    }
    
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return NextResponse.json({ message: 'User with this email already exists.' }, { status: 409 });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash: hashedPassword,
        role: role === UserRole.RESEARCHER ? UserRole.RESEARCHER : UserRole.USER,
      },
    });

    const { passwordHash: _, ...userWithoutPassword } = newUser;
    console.log(_)
    return NextResponse.json(userWithoutPassword, { status: 201 });

  } catch (error) {
    console.error("Registration API error:", error);
    return NextResponse.json({ message: 'Something went wrong during registration.' }, { status: 500 });
  }
}