"""本机控制入口；只调用已连接扩展公开的有界指令。"""
import argparse
import json
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

BASE = 'http://127.0.0.1:8926'
ROOT = Path(__file__).resolve().parent


def call(path, body=None):
    headers = {}
    if body is not None:
        headers = {'Content-Type': 'application/json',
                   'Authorization': 'Bearer ' + (ROOT / 'private/control.key').read_text('utf-8')}
    request = Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    try:
        with urlopen(request, timeout=5) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(json.load(error).get('error', str(error))) from error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['status', 'read', 'focus', 'scroll', 'open_job', 'navigate', 'back', 'reload', 'input', 'click', 'hover', 'stop', 'search-start', 'search-state', 'search-library', 'search-stop', 'search-export'])
    parser.add_argument('--y', type=int, default=0)
    parser.add_argument('--url')
    parser.add_argument('--key')
    parser.add_argument('--ref')
    parser.add_argument('--value')
    parser.add_argument('--target', choices=['page','list','detail'], default='page')
    parser.add_argument('--profile', type=Path)
    parser.add_argument('--format', choices=['md','csv','json'], default='md')
    parser.add_argument('--run-id')
    args = parser.parse_args()
    if args.action.startswith('search-'):
        action=args.action.split('-',1)[1]
        body=json.loads(args.profile.read_text('utf-8')) if action=='start' and args.profile else {'format':args.format} if action=='export' else {}
        if action=='export' and args.run_id:
            body['run_id']=args.run_id
        result=call('/search/'+action,body)
        if action=='export':
            path=ROOT/'private/search'/('候选核对'+('-'+args.run_id if args.run_id else '')+'.'+args.format)
            path.parent.mkdir(parents=True,exist_ok=True)
            path.write_text(result['text'],encoding='utf-8')
            print(path)
        else:
            run=result['run']
            print(json.dumps({'id':run.get('id'),'status':run['status'],'message':run.get('message'),
                              'profile':run['profile'],'candidates':[{'title':c['job']['title'],'url':c['job']['url'],
                              'assessment':c['assessment']} for c in run['candidates'].values()], 'filters':result['filters']},ensure_ascii=False,indent=2))
        return
    if args.action == 'status':
        print(json.dumps(call('/status'), ensure_ascii=False, indent=2))
        return
    arguments = {'y': args.y} if args.action == 'scroll' else {'url': args.url} if args.action in ('open_job', 'navigate') else {}
    if args.action=='scroll' and args.target!='page':
        arguments['target']=args.target
    if args.action in ('input', 'click', 'hover'):
        arguments = {'key': args.key, 'ref': args.ref}
        if args.action == 'input':
            arguments['value'] = args.value
    command = call('/control', {'action': args.action, 'args': arguments})
    if command.get('stopped'):
        print(json.dumps(command, ensure_ascii=False))
        return
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        state = call('/status')
        current = next((c for c in state['commands'] if c['id'] == command['id']), None)
        if current and current['status'] in ('done', 'failed', 'cancelled', 'expired'):
            print(json.dumps({'command': current, 'snapshot': state['snapshot'], 'last_error': state['last_error']}, ensure_ascii=False, indent=2))
            if current['status'] != 'done':
                raise SystemExit(1)
            return
        time.sleep(.5)
    raise SystemExit('扩展未在时限内回执；未重发指令，请检查侧栏和页面')


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as error:
        raise SystemExit(str(error)) from None
