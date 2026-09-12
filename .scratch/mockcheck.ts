import { mockResponse } from '../src/agent/mock-responses';
const msgs = [
  'A task list I can sign in to, with my tasks saved',
  'A shared team task list everyone signed in can see, with sign in',
];
for (const m of msgs) {
  const out = mockResponse({ system: '', context: '', messages: [{ role: 'user', content: m }] } as never);
  console.log(JSON.stringify(m));
  console.log('   first line:', out.split('\n')[0].slice(0, 90));
  console.log('   entity tag:', out.includes('<entity'), '| shared wording:', out.includes('Team tasks'));
}
