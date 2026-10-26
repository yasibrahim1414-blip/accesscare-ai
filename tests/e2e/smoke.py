from playwright.sync_api import sync_playwright
import os
url='file://'+os.path.abspath('dist/preview-test.html')
with sync_playwright() as p:
    b=p.chromium.launch(args=['--use-gl=swiftshader','--enable-webgl','--ignore-gpu-blocklist'])
    pg=b.new_page(viewport={'width':390,'height':844})
    errs=[]; pg.on('pageerror',lambda e: errs.append(str(e))); pg.on('console',lambda m: m.type=='error' and errs.append(m.text))
    pg.goto(url); pg.wait_for_timeout(800)
    pg.screenshot(path='/tmp/claude-0/s1.png')
    print('errors',errs[:5])
    b.close()
