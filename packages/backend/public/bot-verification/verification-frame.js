(() => {
  'use strict';
  const params=new URLSearchParams(location.search),nonce=params.get('nonce'),parentOrigin=params.get('parentOrigin');
  if(!nonce||!/^[a-f0-9]{32}$/.test(nonce)||!parentOrigin||parentOrigin===location.origin||parent===window)return;
  const send=(state,token='')=>parent.postMessage({type:'CASHINGULARITY_BOT_VERIFICATION',nonce,state,token},parentOrigin);
  let initialized=false;
  addEventListener('message',event=>{
    if(initialized||event.source!==parent||event.origin!==parentOrigin)return;
    const message=event.data;
    if(message?.type!=='CASHINGULARITY_BOT_CONFIG'||message.nonce!==nonce||!['login','register'].includes(message.action)||!['light','dark'].includes(message.theme)||typeof message.sitekey!=='string')return;
    initialized=true;document.body.dataset.theme=message.theme;
    const status=document.getElementById('status');
    const script=document.createElement('script');
    const fail=()=>{status.textContent='Verification could not load. Retry from the wallet.';send('error');};
    const timer=setTimeout(fail,15000);
    script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;script.defer=true;
    script.onerror=()=>{clearTimeout(timer);fail();};
    script.onload=()=>{
      clearTimeout(timer);
      if(!window.turnstile){fail();return;}
      status.textContent='';
      window.turnstile.render(document.getElementById('challenge'),{sitekey:message.sitekey,action:message.action,theme:message.theme,size:'flexible',retry:'never',
        callback:token=>send('verified',token),
        'expired-callback':()=>{status.textContent='Verification expired.';send('expired');},
        'error-callback':()=>{fail();return true;},
      });
    };
    document.head.appendChild(script);
  });
  send('ready');
})();
