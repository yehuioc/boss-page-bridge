// Pure extraction from the observed page text and links. No network or browser input.
function extractBossJob(page) {
  const descriptionAt = page.text.indexOf('职位描述');
  const detail = /^https:\/\/www\.zhipin\.com\/job_detail\/[^/]+\.html$/.test(page.url);
  const more = page.selected_detail || page.links.find(link => link.text === '查看更多信息' && /\/job_detail\//.test(link.url));
  if (descriptionAt < 0 || (!detail && !more)) return null;
  const jobUrl = detail ? page.url : more.url;
  const titleMatch = page.title.match(/^「(.+)招聘」_(.+)招聘-BOSS直聘$/);
  const index = page.links.findIndex(link => link.url === jobUrl && link.text !== '查看更多信息');
  const title = detail ? titleMatch?.[1] : more?.title || page.links[index]?.text;
  if (!title) return null;
  let company = detail ? titleMatch?.[2] || null : more?.company || null;
  if (!company && index >= 0) {
    for (const link of page.links.slice(index + 1)) {
      if (/\/job_detail\//.test(link.url)) break;
      if (/\/gongsi\//.test(link.url)) { company = link.text; break; }
    }
  }
  const headingAt = page.text.lastIndexOf(title, descriptionAt);
  if (headingAt < 0) return null;
  const header = page.text.slice(headingAt + title.length, descriptionAt).trim();
  const salaryRaw = header.match(/[\d\uE000-\uF8FF]+(?:[.,][\d\uE000-\uF8FF]+)?(?:\s*[-~–—至]\s*[\d\uE000-\uF8FF]+(?:[.,][\d\uE000-\uF8FF]+)?)?\s*(?:[kKwW千万]|元)(?:\/[天时月年])?(?:\s*[·•]\s*[\d\uE000-\uF8FF]+薪)?/)?.[0] || null;
  const privateDigits = !!salaryRaw && /[\uE000-\uF8FF]/.test(salaryRaw);
  const experience = header.match(/(?:\d+\s*[-~至]\s*\d+年|\d+年以上|在校\/应届|应届生|在校生|经验不限|无需经验|\d+年以内)/)?.[0] || null;
  const education = header.match(/博士|硕士|本科|大专|中专\/中技|中专|中技|高中|初中及以下|学历不限/)?.[0] || null;
  const salaryEnd = salaryRaw ? header.indexOf(salaryRaw) + salaryRaw.length : 0;
  const locationLine = header.slice(salaryEnd).split('\n').map(line => line.trim()).find(Boolean) || '';
  const city = locationLine.split(/\s+/)[0];
  const location = city && !/收藏|感兴趣|沟通|简历|举报|分享/.test(city) && city !== experience && city !== education ? city : null;
  let body = page.text.slice(descriptionAt + '职位描述'.length).trim();
  const endings = [/\n[^\n]{1,20}(?:女士|先生)\n/, /\n竞争力分析(?:\n|$)/, /\nBOSS 安全提示(?:\n|$)/, /\n公司介绍(?:\n|$)/, /\n工作地址(?:\n|$)/, /\n看过该职位的人还看了(?:\n|$)/];
  // The recruiter need not use a courtesy suffix. Require both the activity
  // line and this job's company so a name inside the description is preserved.
  if (company) {
    const companyPattern = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    endings.push(new RegExp('\\n[^\\n]{1,20}\\n(?:在线|刚刚活跃|今日活跃|\\d+分钟前活跃)\\n' + companyPattern + '(?:\\s*[·\\n]|$)'));
  }
  const end = Math.min(...endings.map(pattern => {const match = pattern.exec(body); return match ? match.index : body.length;}));
  body = body.slice(0, end).trim();
  const dutiesHeading = /(?:^|\n)[ \t]*岗位职责[ \t]*(?:[：:]|(?=\r?\n|$))/.exec(body);
  const requirementsHeading = /(?:^|\n)[ \t]*任职要求[ \t]*(?:[：:]|(?=\r?\n|$))/.exec(body);
  const duties = dutiesHeading ? body.slice(dutiesHeading.index + dutiesHeading[0].length,
    requirementsHeading && requirementsHeading.index > dutiesHeading.index ? requirementsHeading.index : body.length).trim() : null;
  const requirements = requirementsHeading ? body.slice(requirementsHeading.index + requirementsHeading[0].length).trim() : null;
  const warnings = [];
  if (privateDigits) warnings.push('薪资包含字体专用字符，待薪资区域截图核对');
  if (!salaryRaw) warnings.push('没有可靠识别到薪资');
  if (!company) warnings.push('公司名称未能确定');
  if (!duties || !requirements) warnings.push('职责或要求未分段，保留职位描述原文');
  if (page.truncated) warnings.push('整页原文已截断，职位描述可能不完整');
  return {layout: detail ? 'detail_page' : 'list_detail', url: jobUrl, title, company,
    salary_raw: salaryRaw, salary: privateDigits ? null : salaryRaw,
    salary_status: privateDigits ? 'needs_visual_review' : salaryRaw ? 'dom_text' : 'unknown',
    location, experience, education, duties, requirements, description: body,
    captured_at: page.captured_at, warnings};
}
