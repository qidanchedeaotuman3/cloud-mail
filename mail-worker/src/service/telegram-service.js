import orm from '../entity/orm';
import email from '../entity/email';
import settingService from './setting-service';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
dayjs.extend(utc);
dayjs.extend(timezone);
import { eq } from 'drizzle-orm';
import jwtUtils from '../utils/jwt-utils';
import emailMsgTemplate from '../template/email-msg';
import emailTextTemplate from '../template/email-text';
import emailHtmlTemplate from '../template/email-html';
import verifyUtils from '../utils/verify-utils';

// 智能解析发件人/收件人字段（兼容字符串、对象、JSON数组）
function parseEmailField(field) {
    if (!field) return '未知';
    if (typeof field === 'string') {
        try {
            const parsed = JSON.parse(field);
            return parseEmailField(parsed);
        } catch (e) {
            return field;
        }
    }
    if (Array.isArray(field)) {
        return field.map(item => item.address || item.name || JSON.stringify(item)).join(', ');
    }
    if (typeof field === 'object') {
        return field.address || field.name || JSON.stringify(field);
    }
    return String(field);
}

const telegramService = {

    async getEmailContent(c, params) {
        const { token } = params;
        const result = await jwtUtils.verifyToken(c, token);
        if (!result) return emailTextTemplate('Access denied');
        const emailRow = await orm(c).select().from(email).where(eq(email.emailId, result.emailId)).get();
        if (emailRow) {
            if (emailRow.content) {
                const { r2Domain } = await settingService.query(c);
                return emailHtmlTemplate(emailRow.content || '', r2Domain);
            } else {
                return emailTextTemplate(emailRow.text || '');
            }
        } else {
            return emailTextTemplate('The email does not exist');
        }
    },

    async sendEmailToBot(c, email) {
        // ==========================================
        // 1. 原有收取邮件转发给 TG 的逻辑
        // ==========================================
        const { tgBotToken, tgChatId, customDomain, tgMsgTo, tgMsgFrom, tgMsgText } = await settingService.query(c);
        const tgChatIds = tgChatId.split(',');
        const jwtToken = await jwtUtils.generateToken(c, { emailId: email.emailId });
        let safeDomain = customDomain.startsWith('http') ? customDomain : `https://${customDomain}`;
        const webAppUrl = customDomain ? `${safeDomain}/api/telegram/getEmail/${jwtToken}` : 'https://www.cloudflare.com/404';

        await Promise.all(tgChatIds.map(async chatId => {
            try {
                await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        parse_mode: 'HTML',
                        text: emailMsgTemplate(email, tgMsgTo, tgMsgFrom, tgMsgText),
                        reply_markup: { inline_keyboard: [[{ text: '查看', web_app: { url: webAppUrl } }]] }
                    })
                });
            } catch (e) {}
        }));

        // ==========================================
        // 2. 企微 Textcard卡片 (智能解析收发件人)
        // ==========================================
        try {
            const corpId = c.env && c.env.QYWX_CORPID;
            const secret = c.env && c.env.QYWX_SECRET;
            const agentId = c.env && c.env.QYWX_AGENTID;
            const toUser = (c.env && c.env.QYWX_TOUSER) || '@all';
            
            let qywxApiBase = "https://qyapi.weixin.qq.com";
            if (c.env && c.env.QYWX_PROXY) {
                qywxApiBase = c.env.QYWX_PROXY.trim().replace(/\/$/, '');
            }

            let wxDomain = (c.env && c.env.QYWX_CUSTOM_DOMAIN) ? c.env.QYWX_CUSTOM_DOMAIN.trim() : customDomain;
            let safeWxDomain = wxDomain.startsWith('http') ? wxDomain : `https://${wxDomain}`;
            const wxWebAppUrl = wxDomain ? `${safeWxDomain}/api/telegram/getEmail/${jwtToken}` : 'https://www.cloudflare.com/404';

            if (!corpId || !secret || !agentId) {
                await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: tgChatIds[0], text: `⚠️ 企微推送未触发：缺少 QYWX_CORPID, QYWX_SECRET 或 QYWX_AGENTID 变量。` })
                });
                return; 
            }

            const tokenRes = await fetch(`${qywxApiBase}/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`);
            const tokenData = await tokenRes.json();

            if (tokenData.errcode !== 0) {
                await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: tgChatIds[0], text: `⚠️ 企微 Token 获取失败(走反代)！错误码: ${tokenData.errcode}，原因: ${tokenData.errmsg}` })
                });
                return; 
            }

            if (tokenData.access_token) {
                const safeSubject = email.subject || '无主题';
                
                // 使用智能解析函数，完美提取真实邮箱字符串
                const safeFrom = parseEmailField(email.from || email.fromAddress || email.sender);
                const safeTo = parseEmailField(email.to || email.toAddress || email.recipient);
                
                const textPreview = (email.text || '无纯文本正文').substring(0, 150).replace(/\n/g, '  ') + '...';

                const sendRes = await fetch(`${qywxApiBase}/cgi-bin/message/send?access_token=${tokenData.access_token}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        touser: toUser,
                        msgtype: "textcard",
                        agentid: parseInt(agentId),
                        textcard: {
                            title: `收到新邮件：${safeSubject}`,
                            description: `发件人：${safeFrom}\n收件人：${safeTo}\n\n内容预览：\n${textPreview}`,
                            url: wxWebAppUrl, 
                            btntxt: "查看完整邮件"
                        }
                    })
                });
                
                const sendResult = await sendRes.json();
                
                if (sendResult.errcode !== 0) {
                    await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: tgChatIds[0], text: `⚠️ 企微卡片发送失败(走反代)！错误码: ${sendResult.errcode}，原因: ${sendResult.errmsg}` })
                    });
                }
            }
        } catch (wechatErr) {
            await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: tgChatIds[0], text: `⚠️ 企微反代代码执行异常: ${wechatErr.message}` })
            });
        }
    },

    async renderWebApp(c) {
        const settings = await settingService.query(c);
        const resendTokens = settings.resendTokens || {};
        const domains = Object.keys(resendTokens);
        if (domains.length === 0) domains.push('未配置域名');

        const optionsHtml = domains.map(d => `<option value="${d}">${d}</option>`).join('');

        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
            <script src="https://telegram.org/js/telegram-web-app.js"></script>
            <style>
                body { font-family: sans-serif; padding: 20px; color: var(--tg-theme-text-color); background: var(--tg-theme-bg-color); margin: 0; }
                .form-group { margin-bottom: 15px; }
                label { display: block; font-weight: bold; font-size: 14px; margin-bottom: 5px; color: var(--tg-theme-hint-color); }
                input, textarea, select { width: 100%; box-sizing: border-box; padding: 12px; border: 1px solid var(--tg-theme-hint-color); border-radius: 8px; background: var(--tg-theme-bg-color); color: var(--tg-theme-text-color); font-size: 16px; outline: none; }
                input:focus, textarea:focus, select:focus { border-color: var(--tg-theme-button-color); }
                .email-prefix-group { display: flex; align-items: center; gap: 10px; }
                .email-prefix-group input { flex: 1; margin-bottom: 0; }
                .email-prefix-group select { flex: 1.2; margin-bottom: 0; }
                button { width: 100%; padding: 14px; background: var(--tg-theme-button-color); color: var(--tg-theme-button-text-color); border: none; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer; margin-top: 10px; transition: opacity 0.2s; }
                button:active { opacity: 0.7; }
            </style>
        </head>
        <body>
            <div class="form-group">
                <label>发件邮箱</label>
                <div class="email-prefix-group">
                    <input type="text" id="prefix" placeholder="别名(如: sky)" />
                    <span style="font-size: 18px; font-weight: bold;">@</span>
                    <select id="domain">${optionsHtml}</select>
                </div>
            </div>
            <div class="form-group">
                <label>收件人</label>
                <input type="email" id="toEmail" placeholder="例如: 123@qq.com" />
            </div>
            <div class="form-group">
                <label>邮件标题</label>
                <input type="text" id="subject" placeholder="输入标题" />
            </div>
            <div class="form-group">
                <label>邮件正文</label>
                <textarea id="content" rows="6" placeholder="输入你想发送的内容..."></textarea>
            </div>
            <button onclick="sendData()">🚀 立即发送邮件</button>

            <script>
                let tg = window.Telegram.WebApp;
                tg.expand();
                tg.ready();

                function sendData() {
                    let prefix = document.getElementById('prefix').value || 'admin';
                    let domain = document.getElementById('domain').value;
                    let toEmail = document.getElementById('toEmail').value;
                    let subject = document.getElementById('subject').value;
                    let content = document.getElementById('content').value;

                    if(!toEmail || !subject || !content) {
                        tg.showAlert('⚠️ 请填写完整的收件人、标题和正文！');
                        return;
                    }

                    let data = { action: 'send_email', fromAddress: prefix + '@' + domain, toEmail, subject, content };
                    tg.sendData(JSON.stringify(data));
                    tg.close();
                }
            </script>
        </body>
        </html>`;
        return c.html(html);
    },

    async handleWebhook(c) {
        try {
            const body = await c.req.json();
            const message = body.message;

            if (!message) return c.text('OK');

            const settings = await settingService.query(c);
            const { tgChatId, tgBotToken, resendTokens } = settings;
            const allowedChatIds = tgChatId.split(',');
            const incomingChatId = String(message.chat.id);

            if (!allowedChatIds.includes(incomingChatId)) return c.text('OK');

            if (message.web_app_data) {
                try {
                    const data = JSON.parse(message.web_app_data.data);
                    if (data.action === 'send_email') {
                        const { fromAddress, toEmail, subject, content } = data;
                        const fromDomain = fromAddress.split('@')[1];
                        const resendKey = resendTokens ? resendTokens[fromDomain] : null;

                        if (!resendKey) return c.text('OK'); 

                        const sendRes = await fetch('https://api.resend.com/emails', {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ from: fromAddress, to: toEmail, subject, text: content })
                        });

                        if (sendRes.ok) {
                            await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ chat_id: incomingChatId, text: `✅ 网页发射成功！\n发件人: ${fromAddress}\n收件人: ${toEmail}` })
                            });
                        }
                    }
                } catch (e) {}
                return c.text('OK');
            }

            const text = message.text;
            if (!text) return c.text('OK');

            if (text.startsWith('/send ')) {
                const parts = text.split(' ');
                if (parts.length >= 5) {
                    let defaultDomain = Object.keys(resendTokens || {})[0] || '';
                    let fromInput = parts[1];
                    let fromAddress = fromInput.includes('@') ? fromInput : `${fromInput}@${defaultDomain}`;
                    const toEmail = parts[2];
                    const subject = parts[3];
                    const emailBody = parts.slice(4).join(' ');

                    const fromDomain = fromAddress.split('@')[1];
                    const resendKey = resendTokens ? resendTokens[fromDomain] : null;

                    if (resendKey) {
                        const sendRes = await fetch('https://api.resend.com/emails', {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ from: fromAddress, to: toEmail, subject: subject, text: emailBody })
                        });
                        if (sendRes.ok) {
                            await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                                method: 'POST', headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ chat_id: incomingChatId, text: `✅ 快捷发信成功！\n收件人: ${toEmail}` })
                            });
                        }
                    }
                    return c.text('OK');
                }
            }

            if (text === '/send') {
                const currentUrl = new URL(c.req.url);
                const webAppUrl = currentUrl.origin + '/api/telegram/webapp';

                const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: incomingChatId,
                        text: "✨ 欢迎使用云邮发件面板！\n👇 请点击你的聊天输入框下方的【📝 打开写信面板】按钮！",
                        reply_markup: {
                            keyboard: [[{ text: '📝 打开写信面板', web_app: { url: webAppUrl } }]],
                            resize_keyboard: true,
                            is_persistent: true
                        }
                    })
                });
                
                if (!res.ok) {
                    const err = await res.text();
                    await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ chat_id: incomingChatId, text: `⚠️ 按钮生成失败，错误原因：${err}` })
                    });
                }
            }
            return c.text('OK');
        } catch (error) {
            return c.text('OK');
        }
    }
};

export default telegramService;
