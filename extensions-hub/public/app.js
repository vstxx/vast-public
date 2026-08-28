const csrf=()=>document.cookie.split(';').map(value=>value.trim()).find(value=>value.startsWith('__Host-vast_hub_csrf='))?.split('=').slice(1).join('=')||''
const result=async(response)=>{const body=await response.json();if(!response.ok)throw new Error(body.error||'Request failed.');return body}
const mutate=async(url,body,contentType='application/json')=>result(await fetch(url,{method:'POST',credentials:'same-origin',headers:{'content-type':contentType,'x-csrf-token':decodeURIComponent(csrf())},body}))

document.addEventListener('click',async(event)=>{
  const button=event.target.closest('[data-action]')
  if(!button)return
  const action=button.dataset.action
  if(action==='install'){
    location.href=`vast://extensions/install?id=${encodeURIComponent(button.dataset.id)}`
    return
  }
  if(!csrf())return
  button.disabled=true
  try{
    const note=button.dataset.review?document.querySelector(`[data-review-note="${CSS.escape(button.dataset.review)}"]`)?.value||'':''
    await mutate(button.dataset.url,JSON.stringify(action==='submit'?{warrantyAccepted:true}:{action,note}))
    location.reload()
  }catch(error){alert(error.message)}finally{button.disabled=false}
})

document.querySelector('#create-extension-form')?.addEventListener('submit',async(event)=>{
  event.preventDefault()
  const form=event.currentTarget
  const button=form.querySelector('button[type="submit"]')
  button.disabled=true
  try{
    const data=Object.fromEntries(new FormData(form))
    await mutate('/v1/publisher/extensions',JSON.stringify(data))
    location.reload()
  }catch(error){alert(error.message)}finally{button.disabled=false}
})

document.querySelector('#accept-terms-form')?.addEventListener('submit',async(event)=>{
  event.preventDefault()
  const button=event.currentTarget.querySelector('button[type="submit"]')
  button.disabled=true
  try{await mutate('/v1/publisher/terms/accept',JSON.stringify({accepted:true}));location.reload()}catch(error){alert(error.message)}finally{button.disabled=false}
})

for(const form of document.querySelectorAll('.listing-data-form'))form.addEventListener('submit',async(event)=>{
  event.preventDefault()
  const button=form.querySelector('button[type="submit"]')
  button.disabled=true
  try{
    await mutate(`/v1/publisher/extensions/${encodeURIComponent(form.dataset.extensionId)}/data-practices`,JSON.stringify(Object.fromEntries(new FormData(form))))
    location.reload()
  }catch(error){alert(error.message)}finally{button.disabled=false}
})

document.querySelector('#report-extension-form')?.addEventListener('submit',async(event)=>{
  event.preventDefault()
  const form=event.currentTarget
  const button=form.querySelector('button[type="submit"]')
  button.disabled=true
  try{await mutate(`/v1/extensions/${encodeURIComponent(form.dataset.extensionId)}/reports`,JSON.stringify(Object.fromEntries(new FormData(form))));form.reset();alert('Report received for human review.')}catch(error){alert(error.message)}finally{button.disabled=false}
})

for(const form of document.querySelectorAll('.report-review-form'))form.addEventListener('submit',async(event)=>{
  event.preventDefault()
  const button=form.querySelector('button[type="submit"]')
  const values=Object.fromEntries(new FormData(form))
  button.disabled=true
  try{
    await mutate(`/v1/review/reports/${encodeURIComponent(form.dataset.reportId)}`,JSON.stringify({status:values.status,reason:values.reason,publisherNotified:values.publisherNotified==='true',legalHold:values.legalHold==='true'}))
    location.reload()
  }catch(error){alert(error.message)}finally{button.disabled=false}
})

for(const form of document.querySelectorAll('.upload-form:not(.media-upload-form)'))form.addEventListener('submit',async(event)=>{
  event.preventDefault()
  const input=form.querySelector('input[type="file"]')
  const file=input.files?.[0]
  if(!file)return
  const button=form.querySelector('button[type="submit"]')
  button.disabled=true
  try{
    await mutate(`/v1/publisher/extensions/${encodeURIComponent(form.dataset.extensionId)}/releases`,file,'application/vnd.vast.extension+zip')
    location.reload()
  }catch(error){alert(error.message)}finally{button.disabled=false}
})

for(const form of document.querySelectorAll('.media-upload-form'))form.addEventListener('submit',async(event)=>{
  event.preventDefault()
  const file=form.querySelector('input[type="file"]').files?.[0]
  if(!file)return
  const button=form.querySelector('button[type="submit"]')
  button.disabled=true
  try{
    await mutate(`/v1/publisher/extensions/${encodeURIComponent(form.dataset.extensionId)}/media?kind=${encodeURIComponent(form.dataset.kind)}`,file,file.type)
    location.reload()
  }catch(error){alert(error.message)}finally{button.disabled=false}
})
