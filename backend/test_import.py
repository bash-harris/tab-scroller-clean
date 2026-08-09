import sys
import traceback

try:
    import api.views
    with open('import_error.txt', 'w') as f:
        f.write('OK')
except Exception as e:
    with open('import_error.txt', 'w') as f:
        traceback.print_exc(file=f)
