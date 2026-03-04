import { randomUUID } from 'crypto';

const firstNames = ['James', 'Mary', 'Robert', 'Patricia', 'Michael', 'Jennifer', 'William', 'Linda', 'David', 'Barbara', 'Richard', 'Elizabeth', 'Joseph', 'Susan', 'Thomas', 'Jessica', 'Charles', 'Sarah', 'Christopher', 'Karen'];

const lastNames = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin'];

const countries = ['US', 'GB', 'CA', 'AU', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'CH', 'SE', 'NO', 'DK', 'JP', 'CN', 'IN', 'BR', 'MX', 'ZA'];

const emailDomains = ['gmail.com', 'yahoo.com', 'outlook.com', 'example.com', 'test.com', 'mail.com', 'email.com', 'domain.com'];

function getRandomDate() {
  const start = new Date('2025-01-01').getTime();
  const end = new Date('2025-12-31').getTime();
  const randomTime = start + Math.random() * (end - start);
  return new Date(randomTime).toISOString();
}

function generateUsers(count) {
  const users = [];
  for (let i = 0; i < count; i++) {
    const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
    const lastName = lastNames[Math.floor(Math.random() * lastNames.length)];
    const name = `${firstName} ${lastName}`;
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${Math.floor(Math.random() * 1000)}@${emailDomains[Math.floor(Math.random() * emailDomains.length)]}`;
    const country = countries[Math.floor(Math.random() * countries.length)];
    
    users.push({
      id: randomUUID(),
      name,
      email,
      country,
      createdAt: getRandomDate()
    });
  }
  return users;
}

console.log(JSON.stringify(generateUsers(20), null, 2));
