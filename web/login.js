// Inicio de sesión del panel
document.getElementById('f').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  const r = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: document.getElementById('u').value, password: document.getElementById('p').value }),
  });
  if (r.ok) location.href = '/';
  else err.textContent = r.status === 429 ? 'Too many attempts. Try again in 15 minutes.' : 'Wrong user or password.';
});
