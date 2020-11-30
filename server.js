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
        result.status = 500;
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
function getEntry(req, key, urlPath) {
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
        result.error = "No entity with this id exists";
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

        // Add indicators for pagination
        if (info.moreResults != datastore.NO_MORE_RESULTS) {
          result.cursor = req.protocol + "://" + req.get("host") + urlPath + "?cursor=" + info.endCursor;
        }

        result.status = 200;
        result.entities = entities;
      }
      resolve(result);
    });
  });
}


// Modifies the entry in the Datastore and return error results
function editEntry(updatedEntity) {
  var result = {
    'status': null,
    'error': null
  };

  return new Promise(resolve => {
    datastore.update(updatedEntity, (err, apiResponse) => {
      if (err) {
        result.status = 404;
        result.error = "No entity with this id exists";
      } else {
        result.status = 200;
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
        result.status = 404;
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
    const entryData = await getEntry(req, result.key, urlPath);

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


// Gets the entry list with pagination and sends a response back with the entries information.
async function getEntryListAndRespond(req, res, kind, urlPath, paginationLimit) {
  const query = datastore.createQuery(kind).limit(paginationLimit);

  if (req.query.cursor) {
    query.start(req.query.cursor);
  }

  const entryList = await getEntryList(req, query, urlPath);

  // Respond with entities list or error message
  if (entryList.error == null) {
    res.status(entryList.status).json({
      'entities': entryList.entities,
      'next': entryList.cursor
    });
  } else {
    res.status(entryList.status).json({'Error': entryList.error});
  }
}

/////////////////// General Functions ///////////////////

// Checks if the passed key has the matching attribute
async function checkDuplicate(req, kind, attr, value) {

  const query = datastore.createQuery(kind).filter(attr, '=', value);

  // Get entry from Datastore
  const entryList = await getEntryList(req, query, "");

  var response = {
    error: null,
    duplicate: null
  }

  if (entryList.error != null) {
    response.error = entryList.error;
  } else if (entryList.entities.length > 0) {
    response.duplicate = true;
  } else {
    response.duplicate = false;
  }

  return response;
}

// Validate content request for JSON
function validJSONAccept(req, res) {
  if (req.get('Accept') != '*/*' && req.get('Accept') != 'application/json' && req.get('Accept') != 'text/html') {
    //Send response status and error message
    res.status(406).json({
      "Error": "The request asks for an unsupported media type"
    });
    return false
  }
  return true;
}

// Validates if the credentials exist
async function credentialsExist(req, res) {
  ticket = null;

  try {
    // Check the JWT value
    ticket = await oauth2Client.verifyIdToken({
      idToken: req.headers.authorization.substring(7),
      audience: CLIENT_ID
    });
  } catch (error) {
    //Send response status and error message
    res.status(403).json({
      "Error": "Credentials do not allow for access to this entity"
    });
  }

  return ticket;
}

////////////////////////////////// Routing //////////////////////////////////


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

/////////////////// Engineering Change Helper Functions ///////////////////

// Attribute valid check for EC. Determines that only valid attributes are used with
// valid data types.
function attributeCheckEC(req, res) {
  var validReq = true;

  // Check for duplicate inputs
  var typeCount = 0;
  var dateCount = 0;
  var historyCount = 0;
  var planCount = 0;
  
  for (prop in req.body) {
    switch(prop) {
      case 'type':
        if ((typeof req.body[prop] != 'string') || typeCount > 0) {
          validReq = false;
        }
        typeCount++;
        break;
      case 'date_created':
        if ((typeof req.body[prop] != 'string') || dateCount > 0) {
          validReq = false;
        }
        dateCount++;
        break;
      case 'history':
        if ((typeof req.body[prop] != 'string') || historyCount > 0) {
          validReq = false;
        }
        historyCount++;
        break;
      case 'plan':
        if ((typeof req.body[prop] != 'string') || planCount > 0) {
          validReq = false;
        }
        planCount++;
        break;
      default:
        validReq = false;
    }
  }

  if (validReq) {
    return true;
  } else {
    //Send response status and error message
    res.status(400).json({
      "Error": "The request object is missing required attributes, contains not allowed information, or the attribute has the wrong value type"
    });
    return false;
  }
}

// Required attribute check for EC.
function requiredAttributeCheckEC(req, res) {
  var containsHistory = false;
  var containsPlan = false;

  for (prop in req.body) {
    if (prop == 'history') {
      containsHistory = true;
    } else if (prop == 'plan') {
      containsPlan = true;
    }
  }
  
  if (containsHistory && containsPlan) {
    return true;
  } else {
    //Send response status and error message
    res.status(400).json({
      "Error": "The request object is missing required attributes, contains not allowed information, or the attribute has the wrong value type"
    });
    return false;
  }
}

// Default Attribute set for EC.
function defaultAttributeSetEC(req) {

  // Check for the optional attributes
  var containsType = false;
  var containsDate = false;

  for (prop in req.body) {
    if (prop == 'type') {
      containsType = true;
    } else if (prop == 'date') {
      containsDate = true;
    }
  }
  
  // Set the default values if missing
  if (!containsType) {
    req.body.type = "fast"
  }

  if (!containsDate) {
    // Source: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date
    var [month, date, year] = new Date().toLocaleDateString("en-US").split("/")
    req.body.date_created = month + "/" + date + "/" + year

  }
}


// Check if the credentials allow access to record
async function validOwner(req, res, ticket, entryKey) {

  // Get engineering change to check owner
  const getResponse = await getEntry(req, ecKey, "/engineering_changes/");
  if (getResponse.error != null) {
    res.status(getResponse.status).json({
      "Error": getResponse.error
    });
    return false;
  }

  // Return error if not the owner of the engineering change
  if (getResponse.entity.owner != ticket.getPayload().sub) {
    res.status(403).json({
      "Error": "Credentials do not allow for access to this entity"
    });
    return false;
  }

  return true;
}

/////////////////// Engineering Change Routing ///////////////////

// Create a Engineering Change
app.post('/engineering_changes', async (req, res) => {
  
  // Validate content request
  if (!validJSONAccept(req, res)) {
    return;
  }

  // Check if credentials exist
  var ticket = await credentialsExist(req, res)
  if (ticket == null) {
    return;
  }

  // Validate input for data type and for valid attributes
  if (!attributeCheckEC(req, res)) {
    return;
  }

  // Validate for all required
  if (!requiredAttributeCheckEC(req, res)) {
    return;
  }

  // Set default values if not provided
  defaultAttributeSetEC(req)

  // Prepares the new entity
  const ecEntity = {
    key: datastore.key('Engineering-Change'),
    data: {
      type: req.body.type,
      date_created: req.body.date_created,
      history: req.body.history,
      plan: req.body.plan,
      parts_changed: [],
      owner: ticket.getPayload().sub
    },
  };

  // Create entry and respond with values
  createEntry(req, res, ecEntity, "engineering change", "/engineering_changes/");
});


// Get a Engineering Change
app.get('/engineering_changes/:ec_id', async (req, res) => {

  // Get entity key
  const ecKey = datastore.key(['Engineering-Change', Number(req.params.ec_id)]);

  // Validate content request
  if (!validJSONAccept(req, res)) {
    return;
  }
  
  // Check if credentials exist
  var ticket = await credentialsExist(req, res)
  if (ticket == null) {
    return;
  }

  //Determine if this is being accessed by the owner
  var validOwner = await credentialsExist(req, res, ticket, ecKey)
  if (!validOwner){
    return;
  }

  var response = {
    status: null,
    content: {}
  };

  // Get entry from Datastore
  const entryData = await getEntry(req, ecKey, "/engineering_changes/");

  // Respond with entity data or error message
  if (entryData.error != null) {
    res.status(entryData.status).json({'Error': entryData.error});
  } else {
    res.status(entryData.status).json(entryData.entity);
  }
});


// // Get all of the users public boats
// app.get('/owners/:owner_id/boats', async (req, res) => {

//   query = datastore.createQuery("Boat").filter('owner', req.params.owner_id).filter('public', true);
//   const entryList = await getEntryList(req, query, "/boats/");

//   // Respond with entities list or error message
//   if (entryList.error == null) {
//     res.status(entryList.status).json(entryList.entities);
//   } else {
//     res.status(entryList.status).json({'Error': entryList.error});
//   }
// });


// // Get all Allowed Boats
// app.get('/boats', async (req, res) => {

//   // Check the JWT value
//   var query
//   try {
//     ticket = await oauth2Client.verifyIdToken({
//       idToken: req.headers.authorization.substring(7),
//       audience: CLIENT_ID
//     });

//     query = datastore.createQuery("Boat").filter('owner', ticket.getPayload().sub);
//   } catch (error) {
//     query = datastore.createQuery("Boat").filter('public', true);
//   }

//   const entryList = await getEntryList(req, query, "/boats/");

//   // Respond with entities list or error message
//   if (entryList.error == null) {
//     res.status(entryList.status).json(entryList.entities);
//   } else {
//     res.status(entryList.status).json({'Error': entryList.error});
//   }
// });


// Update a Engineering Change
app.put('/engineering_changes/:ec_id', async (req, res) => {

  // Get entity key
  const ecKey = datastore.key(['Engineering-Change', Number(req.params.ec_id)]);

  // Validate content request
  if (!validJSONAccept(req, res)) {
    return;
  }

  // Check if credentials exist
  var ticket = await credentialsExist(req, res)
  if (ticket == null) {
    return;
  }

  //Determine if this is being accessed by the owner
  var validOwner = await credentialsExist(req, res, ticket, ecKey)
  if (!validOwner){
    return;
  }

  // Validate input for data type and for valid attributes
  if (!attributeCheckEC(req, res)) {
    return;
  }

  // Validate for all required
  if (!requiredAttributeCheckEC(req, res)) {
    return;
  }

  // Set default values if not provided
  defaultAttributeSetEC(req)

  // Prepare the updated entity
  const ecEntity = {
    key: ecKey,
    data: {
      type: req.body.type,
      date_created: req.body.date_created,
      history: req.body.history,
      plan: req.body.plan,
      parts_changed: [],  //TODO Should it clear relationship?
      owner: ticket.getPayload().sub
    },
  };

  const editResponse = await editEntry(ecEntity);

  // Respond with entities list or error message
  if (editResponse.error == null) {
    // Populate return entity
    entity = ecEntity.data
    entity.id = req.params.ec_id;
    entity.self = req.protocol + "://" + req.get("host") + "/engineering_changes/" + req.params.ec_id;
    res.status(303).set("Location", entity.self).json(entity);
  } else {
    res.status(editResponse.status).json({'Error': editResponse.error});
  }
});


// // Edit a Boat
// app.patch('/boats/:boat_id', async (req, res) => {

//   // Validate content type
//   if (req.get('Content-Type') != 'application/json') {
//     res.status(415).json({
//       "Error": "The request uses a unsupported media type"
//     });
//     return;
//   }
  
//   // Validate content request
//   if (req.get('Accept') != '*/*' && req.get('Accept') != 'application/json') {
//     res.status(406).json({
//       "Error": "The request asks for an unsupported media type"
//     });
//     return;
//   }

//   // Validate input
//   containsValidName = false;
//   containsValidType = false;
//   containsValidLength = false;
//   containsNonvalid = false;

//   for (prop in req.body) {
//     if (prop == 'name') {
//       containsValidName = true;
//     } else if (prop == 'type') {
//       containsValidType = true;
//     } else if (prop == 'length' && typeof req.body[prop] == 'number') {
//       containsValidLength = true;
//     } else {
//       containsNonvalid = true;
//     }
//   }

//   // Return error if bad input
//   if (!(containsValidName ||
//         containsValidType ||
//         containsValidLength)
//       ||
//       containsNonvalid) {
//     res.status(400).json({
//       "Error": "The request object has no valid attributes, contains not allowed information, or the attribute has the wrong value type"
//     });
//     return;
//   }

//   // Check for duplicates if name changed
//   if (containsValidName) {
//     var duplicateResponse = await checkDuplicate(req, 'Boat', 'name', req.body.name);

//     if (duplicateResponse.error != null) {
//       res.status(400).json({
//         "Error": "Falied to determine if the name was a duplicate"
//       });
//       return;
//     } else if (duplicateResponse.duplicate == true) {
//       res.status(403).json({
//         "Error": "The request uses a already existing name"
//       });
//       return;
//     }
//   }

//   // Get old from Datastore
//   const key = datastore.key(['Boat', Number(req.params.boat_id)]);
//   const oldData = await getEntry(req, key, "/boats/");

//   // Update to new information
//   if (containsValidName) {
//     nameVal = req.body.name;
//   } else {
//     nameVal = oldData.entity.name;
//   }

//   if (containsValidType) {
//     typeVal = req.body.type;
//   } else {
//     typeVal = oldData.entity.type;
//   }

//   if (containsValidLength) {
//     lengthVal = req.body.length;
//   } else {
//     lengthVal = oldData.entity.length;
//   }

//   // Prepare the updated entity
//   const boat = {
//     key: datastore.key(['Boat', Number(req.params.boat_id)]),
//     data: {
//       name: nameVal,
//       type: typeVal,
//       length: lengthVal,
//     },
//   }

//   const editResponse = await editEntry(boat);

//   // Respond with entities list or error message
//   if (editResponse.error == null) {
//     // Populate return entity
//     entity = boat.data
//     entity.id = req.params.boat_id;
//     entity.self = req.protocol + "://" + req.get("host") + "/boats/" + req.params.boat_id;
//     res.status(editResponse.status).json(entity);
//   } else {
//     res.status(editResponse.status).json({'Error': editResponse.error});
//   }
// });


// Delete a Engineering Change
app.delete('/engineering_changes/:ec_id', async (req, res) => {

  // Get entity key
  const ecKey = datastore.key(['Engineering-Change', Number(req.params.ec_id)]);
  
  // Check if credentials exist
  var ticket = await credentialsExist(req, res)
  if (ticket == null) {
    return;
  }

  //Determine if this is being accessed by the owner
  var validOwner = await credentialsExist(req, res, ticket, ecKey)
  if (!validOwner){
    return;
  }

  const deleteResponse = await deleteEntry(ecKey, "engineering change");

  // Respond with entities list or error message
  if (deleteResponse.error == null) {
    res.status(deleteResponse.status).send();
  } else {
    res.status(deleteResponse.status).json({'Error': deleteResponse.error});
  }
});


// // Edit the Boat List
// app.put('/boats', async (req, res) => {
//   res.status(405).json({'Error': 'The request asks for an unsupported method'});
// });


// // Delete the Boat List
// app.delete('/boats', async (req, res) => {
//   res.status(405).json({'Error': 'The request asks for an unsupported method'});
// });

// Listen to the App Engine-specified port, or 8080 otherwise
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}...`);
});