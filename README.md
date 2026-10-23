https://shaynnonn.github.io/montrealconstructionobservation/
[README.md](https://github.com/user-attachments/files/33888508/README.md)
# Montréal Construction Observatory

GEOG 464, A2 MVP. Shannon Duong Ma.

## The project in five sentences

This is a current map of the island of Montreal showcasing the concentration of construction and it precise location. The goal is to make it friendly users so anyone can use it: resident, urban planners, commercial owners, anyone who is curious about the construction intensity. The current core action is to be able to visualise with color coding the distribution of borough caused by construction. It matters because it can help people understand where construction activity is concentrated and how it can affect them. All current data comes from the City of Montreal or the Federal Government database.

## How to run it

1. Open the project folder in VS Code.
2. Right-click `website/index.html` and choose **Open with Live Server**.
3. The map opens in your browser. It needs an internet connection for the basemap, the libraries and the address search.

To rebuild the data from scratch, open `notebooks/test.ipynb` and choose **Restart & Run All**. The last cell checks the output and prints "All checks passed".

## Term Project folder

| term_project | All the data, java script, html and style for this project |
|---|---|
| `raw_dataset/` | The original files, as downloaded from the portal |
| `notebooks/` | The pipeline notebook: cleans the data and writes the GeoJSON |
| `cleaned_dataset/` | The cleaned worksites as a CSV, for checking in Excel |
| `website/` | `index.html`, `app.js`, the stylesheet, and `data/` with the GeoJSON files the map loads |

## The pipeline

The notebook reads `entraves-travaux-en-cours.csv` ([2050] rows), keeps the useful columns and renames them to plain words, then removes:

- [0] exact duplicates
- [0] rows with no permit ID (the worksite can't be identified)
- [0] rows with no coordinates (the worksite can't be mapped)
- [0] rows outside the island of Montréal (bad coordinates)

It writes [2050] worksites to `website/data/worksites.geojson`. The check cell tests the count, that every point is inside Montréal, that every worksite has the properties the popup uses, and that the file is under 5 MB.

The borough densities (worksites per km²) and the hexagon counts are calculated in the browser with Turf.js, in `app.js`.

# Data sources

All data downloaded on [2026-09-25].

- [Entraves et travaux en cours](https://donnees.montreal.ca/dataset/info-travaux): construction worksites. Ville de Montréal, Creative Commons Attribution 4.0 International.
- [Administrative boundaries of the agglomeration of Montreal (boroughs and related cities)](https://open.canada.ca/data/en/dataset/9797a946-9da8-41ec-8815-f6b276dec7e9): borough and city boundaries[, and the island boundary]. Ville de Montréal, [CC BY 4.0 (Québec)](https://www.donneesquebec.ca/fr/licence/).
- Basemap: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
- Address search: Photon geocoder, using OpenStreetMap data.

Libraries: [Leaflet](https://leafletjs.com/), [Turf.js](https://turfjs.org/), [Leaflet Control Geocoder](https://github.com/perliedman/leaflet-control-geocoder).

Basemap: © OpenStreetMap contributors.

© 2026 Shannon Duong Ma. All rights reserved.

## Not in this iteration

- **Time slider by month**: Did not start the coding process for this feature yet
- **Budget and investment section**: Still trying to gather the dataset for the budget
- **Color Coding**: Debating to add a color coding per construction point
- **Label Named per Borough**: Debating between keeping the current label feature or having a permanent label feaeture of the borough visible


**Next thing I will build:** Time slider by month

## Testing

- The check cell passes: [2050] worksites, all inside Montréal, all with the popup fields.
- [What the check caught, e.g. the old column names didn't match the CSV, so the ID and dates were missing from the GeoJSON. Fixed in the rename step.]
- [Legend check: the borough legend ranges didn't match the colour cut-offs in `getBoroughColor`. Fixed.]

## AI disclosure

**Lane:** Blue 

The tool used was a mix of both Claude (Opus 5.5)and ChatGPT Plus: I broke the building in 4 sets, notbook, basemap + features, index, style

First set was to create the notebook where it can clean my data, and pass all check, converting my csv file to a geojson. Then the base script with minimal feaatures: What I ask was to create me a interactive map with js.code, then I slowly added features.

First feature added was to incorporate the cleaned data set and be able to see the construction point physically on the map, at first they were bunch of pins which made it very buggy since there are many worksite, I was then able to change to circles marker and then when u press a popup would pop

Second feature were to incorporate the hexagon features, I ask the AI tools to create me a code that will allow hexagon to be formatted on the island and color coded them by construction intensity, I decide to make the hexagon of the size of 500m in order to calculate how many construction was in one hexagon which then follow the color coding of it. It also then I added a zoom feature where at a certain level you get different kind of feature layer. The AI suggest that I used the script Turf in order to be able to handle the geographic calculation behind the scene such has creating the hexagon grid and counting which worsite point fall inside each exagon.

Third final feature was the borough level view, instead of having he hexagon as the first overview when you load the map. I decide to incorporate a easier on the eye approach having the borough seperate and the color coded per borough depending on the construction level. Smaller feature we added such as mouse overlay pop up, borough selected highlighted and greyed out zone when pressing a borough (hopefully going to add the budget window pannel here).

So far my testing phase consist of the check cell and live server, I would often need to press F12 in order to fix internal issues and modify my code accordingly.

## After Testing
What is the map about? The density of contstruction in montreal
What do the darkest color mean: The dark red means more construction in that area.

