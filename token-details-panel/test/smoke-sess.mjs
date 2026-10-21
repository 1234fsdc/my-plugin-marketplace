// stdio 冒烟：模拟宿主 initialize → tools/list → tools/call（带 _meta 会话绑定）
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const proc = spawn(process.execPath, [process.argv[2] ?? 'dist/server.mjs'], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = createInterface({ input: proc.stdout });
const send = (o) => proc.stdin.write(JSON.stringify(o) + '\n');
let step = 0;

rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id === 1) {
    console.log('initialize OK:', m.result.serverInfo.name);
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  } else if (m.id === 2) {
    console.log('tools:', m.result.tools.map((t) => t.name).join(','));
    // 模拟宿主注入会话元数据（zcode-context 的 readSessionContext 读取路径）
    send({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: {
        name: 'get_tokens_overview', arguments: {},
        _meta: { 'com.zcode/request-context': { session_id: 'sess_8186b56a-bb99-45e8-84b5-81a0ed57b54f' } },
      },
    });
  } else if (m.id === 3) {
    const d = m.result.structuredContent;
    console.log('\n=== sess（会话绑定）===');
    console.log(JSON.stringify(d.sess, null, 1));
    console.log('\n=== 全局块仍在 ===');
    console.log('sum keys:', Object.keys(d.sum).join(','), '| days:', d.days.length, '| dmodels:', d.dmodels.length);
    // 无绑定情形
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_tokens_overview', arguments: {} } });
  } else if (m.id === 4) {
    console.log('\n无 _meta 时 sess =', m.result.structuredContent.sess);
    // 伪会话 ID
    send({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'get_tokens_overview', arguments: {}, _meta: { 'com.zcode/request-context': { session_id: 'sess_nonexistent' } } },
    });
  } else if (m.id === 5) {
    console.log('伪会话时 sess =', m.result.structuredContent.sess);
    proc.kill();
    process.exit(0);
  }
});

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-01-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
setTimeout(() => { console.error('TIMEOUT'); proc.kill(); process.exit(1); }, 20000);
