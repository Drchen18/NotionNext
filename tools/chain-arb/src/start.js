console.log('ChainDesk 正在启动，请稍候…');
try {
  const { startLocalApplication } = await import('./server.js');
  await startLocalApplication();
} catch (error) {
  const { safeError } = await import('./config.js');
  console.error(`启动失败：${safeError(error)}`);
  process.exitCode = 1;
}
