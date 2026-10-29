"""Exercise the real HTTP parser/router with a non-launching test catalog."""
import json, subprocess, sys, urllib.request, urllib.error
exe=sys.argv[1];port=19823
process=subprocess.Popen([exe,str(port)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
assert process.stdout.readline().strip()=='READY'
def request(path,method='GET',body=None,auth=True):
    headers={'Authorization':'Bearer test-companion-token'} if auth else {}
    data=json.dumps(body).encode() if body is not None else None
    req=urllib.request.Request('http://127.0.0.1:'+str(port)+path,data=data,headers=headers,method=method)
    try:
        with urllib.request.urlopen(req,timeout=5) as r:return r.status,r.read(),r.headers
    except urllib.error.HTTPError as e:return e.code,e.read(),e.headers
try:
    assert request('/api/catalog',auth=False)[0]==401
    status,body,_=request('/api/catalog');assert status==200 and json.loads(body)['version']==1
    assert request('/api/catalog','OPTIONS',auth=False)[0]==204
    assert request('/api/eval','POST',{'code':'anything'})[0]==404
    assert request('/api/artwork/../../connection.json')[0]==400
    assert request('/api/artwork/11111111-1111-4111-8111-111111111111/cover')[2]['Content-Type']=='image/jpeg'
    assert request('/api/artwork/22222222-2222-4222-8222-222222222222/cover')[0]==404
    status,body,_=request('/api/game/11111111-1111-4111-8111-111111111111');assert status==200 and json.loads(body)['description']=='harness game'
    assert request('/api/game/22222222-2222-4222-8222-222222222222')[0]==404
    assert request('/api/game/not-a-uuid')[0]==400
    assert request('/api/launch','POST',{'id':'invalid','requestId':'invalid'})[0]==400
    request_id='55555555-5555-4555-8555-555555555555'
    payload={'id':'11111111-1111-4111-8111-111111111111','requestId':request_id}
    for _ in range(2):
        status,body,_=request('/api/launch','POST',payload);assert status==200 and json.loads(body)['launches']==1
    payload['id']='22222222-2222-4222-8222-222222222222'
    assert request('/api/launch','POST',payload)[0]==409
    print('PASS: authentication, CORS preflight, catalog, game detail, artwork, bounded routing, invalid IDs, unavailable games, duplicate launch requests')
finally:
    process.communicate('\n',timeout=5)
