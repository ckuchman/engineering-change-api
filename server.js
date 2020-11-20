const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser')
const exphbs = require('express-handlebars');
const {Datastore} = require('@google-cloud/datastore');
const {google} = require('googleapis');

const CLIENT_ID = process.env.CLIENT_ID
const CLIENT_SECRET = process.env.CLIENT_SECRET
const REDIRECT_URL = process.env.REDIRECT_URL

// Taken from https://github.com/googleapis/google-api-nodejs-client
const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URL
);

const app = express();
const datastore = new Datastore();

app.enable('trust proxy');

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.engine('handlebars', exphbs({
  defaultLayout: 'main'
}));
app.set('view engine', 'handlebars');

/////////////////// General Datastore Access Functions ///////////////////

// Inserts the Entry into the Datastore and return entity or error results
function insertEntry(newEntry, objectName) {
  var result = {
    'status': null,
    'error': null,
    'key': null
  };

  // Add the entity to the datastore
  return new Promise(resolve => {
    datastore.insert(newEntry, (err, apiResponse) => {
      if (err) {
        console.log(err);
        result.status = 400;
        result.error = "Failed to insert " + objectName;
      } else {
        result.status = 201;
        result.key = apiResponse.mutationResults[0].key.path[0];
      }
      resolve(result);
    });
  });
}


// Get the entry from the Datastore and return entity or error results
function getEntry(req, key, objectName, urlPath) {
  var result = {
    'status': null,
    'error': null,
    'entity': null
  };

  // Add the entity to the datastore
  return new Promise(resolve => {
    datastore.get(key, (err, entity) => {
      if (err || entity == undefined) {
        result.status = 404;
        result.error = "No " + objectName + " with this " + objectName + "_id exists";
      } else {
        result.status = 200;
        entity.id = entity[datastore.KEY].id;
        entity.self = req.protocol + "://" + req.get("host") + urlPath + entity[datastore.KEY].id;
        result.entity = entity;
      }
      resolve(result);
    })
  });
}


// Get the entry list from the Datastore with a passed in query and returns the entries 
// data or any errors.
function getEntryList(req, query, urlPath) {
  var result = {
    'status': null,
    'error': null,
    'entities': null,
    'cursor': null
  };

  return new Promise(resolve => {
    datastore.runQuery(query, (err, entities, info) => {
      if (err) {
        console.log(err);
        result.status = 400;
        result.error = "Failed to get entry list";
      } else {
        
        // Add self and id to all entities
        entities.forEach(function(entity) {
          entity.id = entity[datastore.KEY].id;
          entity.self = req.protocol + "://" + req.get("host") + urlPath + entity[datastore.KEY].id;
        });

        result.status = 200;
        result.entities = entities;
      }
      resolve(result);
    });
  });
}


// Delete the entry in the Datastore and return error results
function deleteEntry(entryKey, objectName) {
  var result = {
    'status': null,
    'error': null,
  };

  return new Promise(resolve => {
    datastore.delete(entryKey, (err, apiResponse) => {
      if (err ||apiResponse.indexUpdates == 0) {
        result.status = 403;
        result.error = "No " + objectName + " with this " + objectName + "_id exists";
      } else {
        result.status = 204;
      }
      resolve(result);
    });
  });
}


/////////////////// Routing-Specific Functions ///////////////////


// Inserts the Entry and sends a response back with the entry information.
async function createEntry(req, res, newEntry, objectName, urlPath) {
  var response = {
    status: null,
    content: {}
  }

  var result = await insertEntry(newEntry, objectName);

  if (result.error == null) { 
    const entryData = await getEntry(req, result.key, objectName, urlPath);

    if (entryData.error == null) {
      response.status = result.status;
      response.content = entryData.entity;
    } else {
      response.status = entryData.status;
      response.content = {'Error': entryData.error};
    }
  } else {
    response.status = result.status;
    response.content = {'Error': result.error};
  }

  res.status(response.status).json(response.content);
}


/////////////////// Routing ///////////////////


app.get("/", (req, res) => {
  res.render('welcome');
});


app.get("/info", (req, res) => {

  const url = oauth2Client.generateAuthUrl({
    // 'online' (default) or 'offline' (gets refresh_token)
    access_type: 'online',
    scope: 'https://www.googleapis.com/auth/userinfo.profile'
  });
  
  res.redirect(url)
});


app.get("/oauth", async (req, res) => {

  //Get token ref:https://github.com/googleapis/google-api-nodejs-client
  const {tokens} = await oauth2Client.getToken(req.query.code);
  oauth2Client.credentials = tokens;

  res.render('user-info', 
  {
    jwt: oauth2Client.credentials.id_token
  });
});

// Create a Boat
app.post('/boats', async (req, res) => {

  // Check the JWT value
  var ticket
  try {
    ticket = await oauth2Client.verifyIdToken({
      idToken: req.headers.authorization.substring(7),
      audience: CLIENT_ID
    });
  } catch (error) {
    res.status(401).json({
      "Error": "Missing or incorrect JWT."
    });
    return;
  }

  //Determine Owner 
  const owner = ticket.getPayload().sub;

  // Prepares the new entity
  const boatEntity = {
    key: datastore.key('Boat'),
    data: {
      name: req.body.name,
      type: req.body.type,
      length: req.body.length,
      public: req.body.public,
      owner: owner
    },
  };

  // Create entry and respond with values
  createEntry(req, res, boatEntity, "boat", "/boats/");
});


// Get all of the users public boats
app.get('/owners/:owner_id/boats', async (req, res) => {

  query = datastore.createQuery("Boat").filter('owner', req.params.owner_id).filter('public', true);
  const entryList = await getEntryList(req, query, "/boats/");

  // Respond with entities list or error message
  if (entryList.error == null) {
    res.status(entryList.status).json(entryList.entities);
  } else {
    res.status(entryList.status).json({'Error': entryList.error});
  }
});


// Get all Allowed Boats
app.get('/boats', async (req, res) => {

  // Check the JWT value
  var query
  try {
    ticket = await oauth2Client.verifyIdToken({
      idToken: req.headers.authorization.substring(7),
      audience: CLIENT_ID
    });

    query = datastore.createQuery("Boat").filter('owner', ticket.getPayload().sub);
  } catch (error) {
    query = datastore.createQuery("Boat").filter('public', true);
  }

  const entryList = await getEntryList(req, query, "/boats/");

  // Respond with entities list or error message
  if (entryList.error == null) {
    res.status(entryList.status).json(entryList.entities);
  } else {
    res.status(entryList.status).json({'Error': entryList.error});
  }
});


// Delete a Boat
app.delete('/boats/:boat_id', async (req, res) => {

  // Check the JWT value
  var ticket
  try {
    ticket = await oauth2Client.verifyIdToken({
      idToken: req.headers.authorization.substring(7),
      audience: CLIENT_ID
    });
  } catch (error) {
    res.status(401).json({
      "Error": "Missing or incorrect JWT."
    });
    return;
  }

  const boatKey = datastore.key(['Boat', Number(req.params.boat_id)]);
  const getResponse = await getEntry(req, boatKey, "boat", "/boats/");

  // Get boat to check owner
  if (getResponse.error != null) {
    res.status(403).json({
      "Error": "No boat of this id"
    });
    return;
  }

  // Return error if not the owner of the boat
  if (getResponse.entity.owner != ticket.getPayload().sub) {
    res.status(403).json({
      "Error": "Not the owner of this boat."
    });
    return;
  }

  const deleteResponse = await deleteEntry(boatKey, "boat");

  // Respond with entities list or error message
  if (deleteResponse.error == null) {
    res.status(deleteResponse.status).send();
  } else {
    res.status(deleteResponse.status).json({'Error': deleteResponse.error});
  }
});


// Listen to the App Engine-specified port, or 8080 otherwise
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}...`);
});