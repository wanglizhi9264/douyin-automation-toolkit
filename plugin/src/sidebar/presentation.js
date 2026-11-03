// Keep one task stage across the sidebar, home entry and floating control.
export function taskStage(task, { running = false, active = new Map(), retry = null } = {}) {
  if (!running) return ({paused:'已暂停',completed:'本轮完成',partial:'本轮结束',starting:'正在准备',pausing:'正在暂停'})[task?.status] || '已暂停';
  if (task?.status === 'pausing') return '正在暂停';
  if (task?.status === 'starting') return '正在准备';
  if (task?.status === 'finalizing') return '正在保存';
  if (task?.recovery?.status === 'waiting' && !active.size) return '等待补下';
  if (task?.recovery?.status === 'running') return '补下中';
  if ([...active.values()].some(i => i.loaded > 0)) return '下载中';
  if (retry) return '等待限流解除';
  if (active.size) return '准备下载';
  return task?.sourceDone ? '正在收尾' : '检查已有作品';
}
export function taskProblem(task, message = '') {
  const detail = message || task?.sourceErrors?.[0] || '';
  if (!detail) return null;
  if (/账号|登录|account|login/i.test(detail)) return {text:'当前账号无法继续。请回到抖音登录备份库对应的账号，再点击下载。',detail};
  if (/其他标签|其他页面|正在使用|锁|lock/i.test(detail)) return {text:'备份库正被其他任务使用。请先暂停其他标签页的下载，再点击下载。',detail};
  if (/Quota|空间|磁盘已满|disk.*full/i.test(detail)) return {text:'磁盘空间不足。请释放空间后再下载，已保存的作品会保留。',detail};
  if (/NotAllowed|NotReadable|权限|授权|文件夹|外接|目录.*不可|设备/i.test(detail)) return {text:'备份文件夹暂不可用。请连接磁盘，重新选择并授权原文件夹。',action:'folder',label:'重新选择文件夹',detail};
  if (/429|限流/i.test(detail)) return {text:'列表请求受到限流，任务已暂停。请稍后再下载，已有备份会跳过。',detail};
  if (/游标|分页|列表.*(未|异常|失败)|pagination/i.test(detail)) return {text:'列表尚未完整读取。已保存作品会保留，请稍后再下载。',detail};
  return {text:detail,detail};
}
export function matchesAuthor(author, query) {
  return !query.trim() || `${author.nickname || ''} ${author.uid || ''}`.toLowerCase().includes(query.trim().toLowerCase());
}
