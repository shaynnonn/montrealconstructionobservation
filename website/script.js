// Create the map
const map = L.map("map", { preferCanvas: true }).setView(
    [45.5019, -73.5674],
    10
);

// Add a basemap
L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
        attribution: "© OpenStreetMap contributors"
    }
).addTo(map);

// ==================================================
// SETTINGS AND SHARED VARIABLES
// ==================================================
const HEX_ZOOM = 12;         // hexagons from this zoom
const POINT_ZOOM = 15;       // individual worksites from this zoom

let focusedBorough = null;   // the borough in focus, or null
let greyLayer = L.layerGroup();   // greys out the other boroughs (rebuilt on each focus)              // greys out the other boroughs
// Search bar: find an address and zoom to it
let searchMarker;


L.Control.geocoder({
    defaultMarkGeocode: false,
    placeholder: "Search an address in Montréal...",
    geocoder: L.Control.Geocoder.photon({
        geocodingQueryParams: {
            bbox: "-73.98,45.40,-73.47,45.70",
            lang: "fr"
        }
    }),
    suggestMinLength: 3,
    suggestTimeout: 300
})
.on("markgeocode", function(e) {
    const place = e.geocode.center;

    // Remove the previous search marker, if any
    if (searchMarker) map.removeLayer(searchMarker);

    // Zoom in and mark the address
    map.setView(place, 16);
    searchMarker = L.marker(place).addTo(map)
        .bindPopup(e.geocode.name)
        .openPopup();
})
.addTo(map);

// Legend Box in Bottom Left Corner

const legend = L.control({ position: "bottomright" });

legend.onAdd = function() {
    this.div = L.DomUtil.create("div", "legend");
    return this.div;
};

legend.addTo(map);

// Fill the legend for the current zoom level
function updateLegend(level) {
    let title, rows;

    if (level === "borough") {
        title = "Worksites per km²";
        rows = [
            ["#800026", "14 or more"],
            ["#BD0026", "11 to 13"],
            ["#FC4E2A", "8 to 10"],
            ["#FD8D3C", "5 to 7"],
            ["#FED976", "Under 5"],
            ["#D9D9D9", "None"]
        ];
    } else {
        title = "Worksites per hexagon";
        rows = [
            ["#800026", "20 or more"],
            ["#BD0026", "11 to 19"],
            ["#FC4E2A", "6 to 10"],
            ["#FD8D3C", "3 to 5"],
            ["#FED976", "1 to 2"],
            ["#D9D9D9", "None"]
        ];
    }

    let focusedBorough = null;   // the borough in focus, or null
    
    let greyLayer;               // greys out the other boroughs
    let html = `<strong>${title}</strong>`;
    rows.forEach(([color, label]) => {
        html += `<div><i style="background:${color}"></i>${label}</div>`;
    });

    // At the closest zoom, also explain the dots
    if (level === "points") {
        html += `<div><i class="dot"></i>One worksite</div>`;
    }

    

    legend.div.innerHTML = html;

}

// Layer for the hexagons
const hexagonLayer = L.featureGroup();
let boroughFillLayer, boroughOutlineLayer;

// Load the Montréal boundary AND construction worksites
Promise.all([
    fetch("data/montreal_boundary.geojson").then(r => r.json()),
    fetch("data/worksites.geojson").then(r => r.json()),
    fetch("data/montreal_boroughs.geojson").then(r => r.json())
])
    .then(([boundaryData, worksites, boroughData]) => {

        // Use the boundary to calculate the extent
        const bbox = turf.bbox(boundaryData);

        // Create 500 m hexagons
        const hexGrid = turf.hexGrid(
            bbox,
            0.5,
            { units: "kilometers" }
        );

        // Keep only hexagons that intersect Montréal
        const montrealHexagons = {
            type: "FeatureCollection",
            features: hexGrid.features.filter(hex => {

    const center = turf.centroid(hex);

    return boundaryData.features.some(boundary =>
        turf.booleanPointInPolygon(center, boundary)
    );

})
        };

// Count worksites and calculate density for each borough
        boroughData.features.forEach(borough => {
            const count = worksites.features.filter(w =>
                turf.booleanPointInPolygon(w, borough)
            ).length;
            const areaKm2 = turf.area(borough) / 1000000;

            borough.properties.count = count;
            borough.properties.density = count / areaKm2;
        });

        // Coloured, clickable boroughs (far view)
        boroughFillLayer = L.geoJSON(boroughData, {
            style: feature => ({
                color: "#ffffff",
                weight: 1,
                fillColor: getBoroughColor(feature.properties.density),
                fillOpacity: 0.7
            }),
            onEachFeature: (feature, layer) => {
                const p = feature.properties;

                // Hover: show the borough's numbers
                layer.bindTooltip(`
                    <strong>${p.NOM}</strong><br>
                    ${p.count} worksites<br>
                    ${p.density.toFixed(1)} per km²
                `, { sticky: true });

                               // Highlight the borough under the mouse
                layer.on("mouseover", () => {
                    layer.setStyle({ fillOpacity: 0.95, weight: 3, color: "#ffffff" });
                    layer.bringToFront();   // so its border isn't hidden by neighbours
                });
                layer.on("mouseout", () => boroughFillLayer.resetStyle(layer));
                // Click: focus on this borough
                layer.on("click", () => focusOn(feature));
            }
            // onEachFeature: (feature, layer) => {
            //     const p = feature.properties;
            //     layer.bindPopup(`
            //         <strong>${p.NOM}</strong><br>
            //         ${p.count} worksites total<br>
            //         ${p.density.toFixed(1)} worksites per km²<br>
            //         <em>Zoom in to see where</em>
            //     `);
            // }
        });

        // Thin outlines that don't block clicks (closer views)
        boroughOutlineLayer = L.geoJSON(boroughData, {
            style: { color: "#555", weight: 1, fill: false },
            interactive: false

        });

        // Covers the boroughs that are NOT in focus
        greyLayer = L.geoJSON(boroughData, {
            style: { stroke: false, fillColor: "#999", fillOpacity: 0 },
            interactive: false   
        });

function getBoroughColor(density) {
    if (density >= 14) return "#800026";
    if (density >= 11) return "#BD0026";
    if (density >= 8)  return "#FC4E2A";
    if (density >= 5)  return "#FD8D3C";
    if (density >= 1)  return "#FED976";
    if (density >= 0)  return "#D9D9D9";
    return "#D9D9D9";
}

 // Count worksites inside each hexagon
    montrealHexagons.features.forEach(hex => {

        let count = 0;

        worksites.features.forEach(worksite => {

            if (turf.booleanPointInPolygon(worksite, hex)) {
                count++;
            }

        });
        
// Save the count inside the hexagon
        hex.properties.project_count = count;
    });

        // Draw the hexagons with color based on # of worksites
L.geoJSON(montrealHexagons, {
    style: function(feature) {
        return {
            color: "#fff",
            weight: 0.5,
            // Color depends on # of worksites in the hexagon
            fillColor: getHexColor(feature.properties.project_count),
            fillOpacity: 0.7
        };
    },
    // Popup showing how many worksites are in this hexagon
    onEachFeature: function(feature, layer) {
        const n = feature.properties.project_count;
        layer.bindPopup(`<strong>${n} worksite${n === 1 ? "" : "s"}</strong> in this hexagon`);
    }
    
}).addTo(hexagonLayer);

        updateLayers();
    });

function getHexColor(count) {

    if (count >= 20) return "#800026";
    if (count >= 11) return "#BD0026";
    if (count >= 6)  return "#FC4E2A";
    if (count >= 3)  return "#FD8D3C";
    if (count >= 1)  return "#FED976";
    if (count === 0) return "#D9D9D9";

    return "#FFF7BC";

}

// Code for zoom in precise location of construction

const projectLayer = L.layerGroup();

// Load the worksites and add them as pins with popups

fetch("data/worksites.geojson")
    .then(response => response.json())
    .then(data => {
        L.geoJSON(data, {
            
         // Draw each worksite as a circle instead of a pin
            pointToLayer: (feature, latlng) => {
                return L.circleMarker(latlng, {
                    radius: 5,
                    color: "#b35900",
                    fillColor: "#ff8c00",
                    fillOpacity: 0.8,
                    weight: 1
                });
            },
            // Attach a popup to each circle
            onEachFeature: (feature, layer) => {
                const p = feature.properties;
                layer.bindPopup(`
                    <strong>${p.reason_category}</strong><br>
                    Organizati: ${p.organizationname || "Not specified"}<br>
                    Borough: ${p.boroughid}<br>on
                    From ${p.duration_startdate} to ${p.duration_enddate}
                `);
            }
        }).addTo(projectLayer);
    
    });

    // Zoom Fuctionality Features
function updateLayers() {
    if (!boroughFillLayer) return;

    const zoom = map.getZoom();

    [boroughFillLayer, boroughOutlineLayer, hexagonLayer, projectLayer, greyLayer]
        .forEach(layer => map.removeLayer(layer));

    if (zoom < HEX_ZOOM && focusedBorough === null) {
        // Far, not focused: boroughs
        map.addLayer(boroughFillLayer);
        updateLegend("borough");
        

    } else if (zoom < POINT_ZOOM) {
        // Hexagons (always, when a borough is in focus)
        hexagonLayer.setStyle({ fillOpacity: 0.7, color: "#fff", weight: 0.5 });
        map.addLayer(hexagonLayer);
        if (focusedBorough) map.addLayer(greyLayer);
        map.addLayer(boroughOutlineLayer);
        updateLegend("hexagon");

    } else {
        // Close: faded hexagons + worksites
        hexagonLayer.setStyle({ fillOpacity: 0.15, color: "#555", weight: 2 });
        map.addLayer(hexagonLayer);
        map.addLayer(projectLayer);
        if (focusedBorough) map.addLayer(greyLayer);
        map.addLayer(boroughOutlineLayer);
        updateLegend("points");
    }
}

//  function updateLayers() {
//     if (!boroughFillLayer) return;   // data not loaded yet

//     const zoom = map.getZoom();

//     // Start from a clean map
//     [boroughFillLayer, boroughOutlineLayer, hexagonLayer, projectLayer]
//         .forEach(layer => map.removeLayer(layer));

//     if (zoom < 12) {
//         // Far: boroughs by worksites per km²
//         map.addLayer(boroughFillLayer);
//         updateLegend("borough");

//     } else if (zoom < 15) {
//         // Middle: hexagons + borough lines
//         hexagonLayer.setStyle({ fillOpacity: 0.7, color: "#fff", weight: 0.5 });
//         map.addLayer(hexagonLayer);
//         map.addLayer(boroughOutlineLayer);
//         updateLegend("hexagon");        

//     } else {
//         // Close: faded hexagons + borough lines + worksites
//         hexagonLayer.setStyle({ fillOpacity: 0.50, color: "#555", weight: 2 });
//         map.addLayer(hexagonLayer);
//         map.addLayer(boroughOutlineLayer);
//         map.addLayer(projectLayer);
//         updateLegend("points");       
//     }
// }

map.on("zoomend", updateLayers);

// ==================================================
// 9. FOCUS MODE: CLICK A BOROUGH TO ZOOM IN ON IT
// ==================================================
const focusPanel = L.control({ position: "topleft" });

focusPanel.onAdd = function() {
    this.div = L.DomUtil.create("div", "focus-panel");
    L.DomEvent.disableClickPropagation(this.div);  // clicks on the panel don't reach the map
    this.div.style.display = "none";               // hidden until a borough is clicked
    return this.div;
};

focusPanel.addTo(map);

function focusOn(feature) {
    focusedBorough = feature;

    // Grey out every borough except this one
    greyLayer.setStyle(f => ({ fillOpacity: f === focusedBorough ? 0 : 0.6 }));

    map.fitBounds(L.geoJSON(feature).getBounds());
    updateFocusPanel();
    updateLayers();
}

function exitFocus() {
    focusedBorough = null;
    greyLayer.setStyle({ fillOpacity: 0 });
    focusPanel.div.style.display = "none";
    map.setView([45.55, -73.65], 11);
    updateLayers();
}

function updateFocusPanel() {
    if (!focusedBorough) return;

    const p = focusedBorough.properties;
    focusPanel.div.innerHTML = `
        <strong>${p.NOM}</strong><br>
        ${p.count} worksites<br>
        ${p.density.toFixed(1)} per km²<br>
        <button id="back-button">Back to all of Montréal</button>
    `;
    focusPanel.div.style.display = "block";
    document.getElementById("back-button").addEventListener("click", exitFocus);
}
