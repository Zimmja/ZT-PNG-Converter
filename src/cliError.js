/**
 * User-facing CLI errors: always show the "ERROR: " prefix once.
 */
function userError(message) {
  const t = String(message).trim();
  if (t.startsWith('ERROR:')) {
    return new Error(t);
  }
  return new Error(`ERROR: ${t}`);
}

function formatCliError(err) {
  const raw =
    err && typeof err.message === 'string' && err.message.length > 0
      ? err.message
      : String(err);
  const m = raw.trim();
  const body = m.length > 0 ? m : 'Something went wrong.';
  return body.startsWith('ERROR:') ? body : `ERROR: ${body}`;
}

module.exports = {
  userError,
  formatCliError,
};
