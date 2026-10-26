// Agent codes: ag01, ag02, ag03 … (next number = highest existing + 1)
function nextAgentCode(db) {
  const rows = db.all("SELECT agentCode FROM agents WHERE agentCode IS NOT NULL AND agentCode <> ''");
  let max = 0;
  rows.forEach(r => {
    const m = /^ag(\d+)$/i.exec(r.agentCode);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'ag' + String(max + 1).padStart(2, '0');
}

module.exports = { nextAgentCode };
