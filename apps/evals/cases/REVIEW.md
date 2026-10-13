# Review rules

- Never log a secret: an API key, a token or a password.
- Amounts are integer cents, never floating-point numbers.
- A query takes its values as parameters, never built into the SQL text.
