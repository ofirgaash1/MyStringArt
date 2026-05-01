# Shared-State Loop First 15 Step Timings

Date: 2026-05-01

Fixture: `mona_lisa.PNG`

Browser: headed Chromium through the app UI.

These are individual step timings, not only averages.

## Dithered

Final preview polygons after capture: `17`

| Step | Color | Line | Score | Total ms | Handler ms | Search ms | Geometry update ms | Line apply ms | React commit ms |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | olive | 285 -> 15 | 0.8353 | 1932.1 | 1927.6 | 1135.1 | 790.9 | 0.5 | 4.5 |
| 2 | olive | 15 -> 276 | 0.8261 | 2117.4 | 2114.6 | 1288.8 | 822.8 | 1.9 | 2.8 |
| 3 | olive | 276 -> 3 | 0.7863 | 2051.4 | 2048.4 | 1273.0 | 773.6 | 0.5 | 3.0 |
| 4 | olive | 3 -> 284 | 0.7584 | 1884.5 | 1881.3 | 1110.2 | 769.5 | 0.7 | 3.2 |
| 5 | olive | 284 -> 24 | 0.7880 | 2032.0 | 2027.2 | 1172.9 | 851.4 | 1.3 | 4.8 |
| 6 | olive | 24 -> 8 | 0.7160 | 2570.3 | 2567.5 | 1577.2 | 988.0 | 1.2 | 2.8 |
| 7 | black | 8 -> 123 | 0.7374 | 1875.4 | 1874.6 | 1213.5 | 648.0 | 10.8 | 0.8 |
| 8 | black | 123 -> 107 | 0.7390 | 1997.7 | 1996.8 | 1386.8 | 608.4 | 0.5 | 0.9 |
| 9 | olive | 8 -> 280 | 0.7352 | 3610.8 | 3605.1 | 1574.4 | 2029.1 | 0.2 | 5.7 |
| 10 | olive | 280 -> 20 | 0.7287 | 2177.5 | 2175.9 | 1350.1 | 824.5 | 0.1 | 1.6 |
| 11 | olive | 20 -> 284 | 0.7136 | 2276.9 | 2276.2 | 1428.6 | 846.6 | 0.2 | 0.7 |
| 12 | olive | 284 -> 19 | 0.7043 | 3255.0 | 3252.9 | 1647.8 | 1603.6 | 0.5 | 2.1 |
| 13 | olive | 19 -> 98 | 0.7227 | 2404.5 | 2403.2 | 1471.5 | 920.0 | 9.5 | 1.3 |
| 14 | olive | 98 -> 56 | 0.7720 | 2190.6 | 2189.8 | 1310.7 | 877.1 | 0.2 | 0.8 |
| 15 | olive | 56 -> 76 | 0.7873 | 2449.5 | 2442.8 | 1556.0 | 878.8 | 4.9 | 6.7 |

Dithered averages for context:

| Metric | Average ms |
| --- | ---: |
| total | 2321.71 |
| handler | 2318.93 |
| search | 1366.44 |
| geometry update | 948.82 |
| line application | 2.20 |
| React commit | 2.78 |

## Nearest

Final preview polygons after capture: `16`

| Step | Color | Line | Score | Total ms | Handler ms | Search ms | Geometry update ms | Line apply ms | React commit ms |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | olive | 22 -> 39 | 0.9995 | 229.8 | 223.9 | 136.9 | 84.9 | 1.3 | 5.9 |
| 2 | olive | 39 -> 299 | 0.9790 | 201.1 | 198.8 | 119.2 | 73.5 | 5.2 | 2.3 |
| 3 | olive | 299 -> 263 | 0.9995 | 213.5 | 211.1 | 134.1 | 75.0 | 1.2 | 2.4 |
| 4 | olive | 263 -> 281 | 0.9740 | 205.6 | 201.3 | 126.6 | 73.0 | 1.1 | 4.3 |
| 5 | olive | 281 -> 298 | 0.9995 | 198.3 | 196.2 | 130.7 | 64.2 | 0.9 | 2.1 |
| 6 | olive | 298 -> 264 | 0.9570 | 202.6 | 200.0 | 128.5 | 68.9 | 2.0 | 2.6 |
| 7 | olive | 264 -> 280 | 0.9661 | 217.3 | 215.0 | 140.5 | 72.0 | 1.4 | 2.3 |
| 8 | olive | 280 -> 22 | 0.9451 | 206.2 | 204.0 | 127.7 | 75.6 | 0.1 | 2.2 |
| 9 | olive | 22 -> 102 | 0.9105 | 222.9 | 216.2 | 139.8 | 71.7 | 3.8 | 6.7 |
| 10 | olive | 102 -> 57 | 0.9883 | 197.6 | 193.1 | 122.6 | 69.3 | 0.5 | 4.5 |
| 11 | olive | 57 -> 79 | 0.9834 | 190.7 | 188.6 | 118.4 | 69.7 | 0.2 | 2.1 |
| 12 | olive | 79 -> 11 | 0.9197 | 198.3 | 195.8 | 116.1 | 76.7 | 1.5 | 2.5 |
| 13 | black | 11 -> 131 | 0.9273 | 168.8 | 166.9 | 127.1 | 38.5 | 0.6 | 1.9 |
| 14 | olive | 11 -> 281 | 0.9071 | 196.3 | 193.4 | 126.7 | 65.9 | 0.3 | 2.9 |
| 15 | olive | 281 -> 208 | 0.9285 | 225.2 | 223.0 | 146.9 | 73.8 | 1.2 | 2.2 |

Nearest averages for context:

| Metric | Average ms |
| --- | ---: |
| total | 204.95 |
| handler | 201.82 |
| search | 129.45 |
| geometry update | 70.18 |
| line application | 1.42 |
| React commit | 3.13 |

## Immediate Observations

1. Dithered is not stable around `1.7s`; over 15 steps it ranged from `1,875.4ms` to `3,610.8ms`.
2. Dithered spikes are mostly geometry update spikes: step 9 had `2,029.1ms` in shared geometry update, step 12 had `1,603.6ms`.
3. Dithered search also grows above the first-3-step diagnosis: the 15-step average search was `1,366.44ms`.
4. Nearest stayed much flatter, ranging from `168.8ms` to `229.8ms`.
5. Nearest geometry update remained around `64-85ms`, except black step 13 at `38.5ms`.
