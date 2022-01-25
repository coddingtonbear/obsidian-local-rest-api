import express from 'express'
import cors from 'cors'

function root(req: express.Request, res: express.Response): void {
  res.sendStatus(200)
}

export default function setupRoutes(app: express.Express) {
  app.use(cors)

  app.get('/', root)
}
